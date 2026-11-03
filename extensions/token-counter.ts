/**
 * Global token counter
 *
 * Shows the all-time cumulative input and output tokens across ALL pi
 * sessions in the footer, bottom-left, as the line below the per-session
 * stats — e.g.  Σ↑12.3M Σ↓1.8M (global)
 *
 * Data source: the `usage` objects the model/provider reported for each
 * response, persisted in every session file (<agent dir>/sessions/**.jsonl):
 *   - assistant messages -> entry.message.usage
 *   - compaction entries -> entry.usage
 *   - branch summaries   -> entry.usage
 *   - usage entries      -> entry.usage
 * Same semantics as the per-session ↑/↓ numbers in the built-in footer,
 * summed over every session. No estimation, no model calls.
 *
 * Performance design (the TUI render path stays free):
 *   - Totals live in memory; the footer line is only re-set when a scan
 *     actually changed them.
 *   - Scans are incremental: per file we remember (mtime, size, byte
 *     offset) and re-read only newly appended bytes, so an active session
 *     parses just the lines added since the last turn.
 *   - Lines without a "usage" key are skipped without JSON.parse.
 *   - Scans run async, off the render path, on: session_start, turn_end,
 *     compaction, tree navigation, session switch, plus a 5s tick that
 *     catches other running pi processes. At most one scan in flight.
 *
 * Loaded automatically from ~/.pi/agent/extensions/.
 *   /token-counter  toggle the counter on/off
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { trackExtensionRun } from "./stats.ts"; // global usage counter (stats extension)

// ---------------------------------------------------------------- config

const STATUS_KEY = "global_tokens";
const RESCAN_INTERVAL_MS = 5_000; // pick up other pi processes / external edits
const MAX_DELTA_BYTES = 16 * 1024 * 1024; // per read() call, safety cap
const MAX_WALK_DEPTH = 4; // sessions/<cwd-slug>/<file>.jsonl is depth 2

// ---------------------------------------------------------------- types

interface UsageLike {
  input?: number;
  output?: number;
}

interface Totals {
  input: number;
  output: number;
}

interface FileState {
  mtimeMs: number;
  /** File size at last scan; the next scan reads only bytes[size..newSize]. */
  size: number;
  /** Trailing partial (not newline-terminated) line, carried over. */
  leftover: Buffer;
  /** Summed usage of all complete lines up to `size`. */
  input: number;
  output: number;
}

// ---------------------------------------------------------------- formatting

/** Same k/M formatting as pi's built-in footer. */
function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

// ---------------------------------------------------------------- usage extraction

/** The usage object an entry carries, or undefined. */
function usageOf(entry: unknown): UsageLike | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as { type?: unknown; usage?: unknown; message?: unknown };
  if (e.type === "message") {
    const m = e.message as { role?: unknown; usage?: unknown } | null;
    return m && m.role === "assistant" && m.usage && typeof m.usage === "object"
      ? (m.usage as UsageLike)
      : undefined;
  }
  if (e.type === "compaction" || e.type === "branch_summary" || e.type === "usage") {
    return e.usage && typeof e.usage === "object" ? (e.usage as UsageLike) : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- file discovery

/** Recursively collect .jsonl session files (bounded depth, ignores errors). */
async function findSessionFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // dir missing or unreadable: nothing to do
  }
  const out: string[] = [];
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await findSessionFiles(p, depth + 1)));
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- scanner

/**
 * Incrementally sums input/output tokens over all session files.
 *
 * Invariant per file: `input`/`output` cover every complete line up to
 * `size`, and `leftover` holds the trailing bytes after the last newline.
 * A scan only reads and parses the bytes appended after `size`. (Files are
 * append-only in pi; an in-place rewrite of the same length is not re-parsed.)
 */
export class GlobalUsageScanner {
  private files = new Map<string, FileState>();
  private total: Totals = { input: 0, output: 0 };

  get totals(): Totals {
    return { input: this.total.input, output: this.total.output };
  }

  /** Incremental rescan of all session files. Idempotent. */
  async scan(sessionsDir: string): Promise<void> {
    const paths = new Set(await findSessionFiles(sessionsDir));
    for (const p of paths) await this.scanFile(p);

    // Forget deleted files (subtract their contribution).
    for (const [p, st] of this.files) {
      if (!paths.has(p)) {
        this.total.input -= st.input;
        this.total.output -= st.output;
        this.files.delete(p);
      }
    }
  }

  private async scanFile(p: string): Promise<void> {
    let stat: import("node:fs").Stats;
    try {
      stat = await fsp.stat(p);
    } catch {
      return; // raced with deletion: removed by the caller's cleanup pass
    }

    const prev = this.files.get(p);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) return; // unchanged

    let input = 0;
    let output = 0;
    let leftover: Buffer = Buffer.alloc(0);
    let readStart: number;
    if (prev) {
      if (stat.size >= prev.size) {
        input = prev.input;
        output = prev.output;
        leftover = prev.leftover;
        readStart = prev.size; // only read bytes appended since the last scan
      } else {
        readStart = 0; // file shrank (truncated/rewritten): re-parse from the start
      }
    } else {
      readStart = 0;
    }

    // Read only the appended bytes.
    if (stat.size > readStart) {
      const fh = await fsp.open(p, "r");
      try {
        for (let pos = readStart; pos < stat.size; ) {
          const len = Math.min(stat.size - pos, MAX_DELTA_BYTES);
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, pos);
          if (bytesRead === 0) break;
          pos += bytesRead;
          leftover = Buffer.concat([leftover, buf.subarray(0, bytesRead)]);
        }
      } finally {
        await fh.close();
      }
    }

    // Split into complete lines; carry the trailing partial line over.
    const lastNl = leftover.lastIndexOf(0x0a);
    if (lastNl === -1) {
      // No complete line yet. If the leftover grows unbounded (a file
      // without newlines), abandon it: never counted, never re-read.
      if (leftover.length > MAX_DELTA_BYTES * 2) leftover = Buffer.alloc(0);
      this.files.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, leftover, input, output });
      this.updateTotal(prev, input, output);
      return;
    }
    const complete = leftover.subarray(0, lastNl + 1);
    leftover = Buffer.from(leftover.subarray(lastNl + 1)); // copy: don't alias the big buffer

    // Fast path: a line can only contribute if it contains a usage key.
    // (If "usage" appears inside a JSON string value instead, parsing that
    // line simply yields no usage key — still correct.)
    for (const line of complete.toString("utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // torn write or foreign file: skip, keep going
      }
      const u = usageOf(entry);
      if (u) {
        if (typeof u.input === "number") input += u.input;
        if (typeof u.output === "number") output += u.output;
      }
    }

    this.files.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, leftover, input, output });
    this.updateTotal(prev, input, output);
  }

  private updateTotal(prev: FileState | undefined, input: number, output: number): void {
    if (prev) {
      this.total.input -= prev.input;
      this.total.output -= prev.output;
    }
    this.total.input += input;
    this.total.output += output;
  }
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  const sessionsDir = path.join(getAgentDir(), "sessions");
  const scanner = new GlobalUsageScanner();

  let enabled = true;
  let activeCtx: ExtensionContext | undefined;
  /** Bumped on session start/shutdown so in-flight scans from a replaced
   *  session cannot write stale UI state. */
  let generation = 0;
  let scanInFlight: Promise<void> | undefined;
  let scanPending = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastText = "";
  /** Theme instance the current status string was styled with. Theme
   *  switching replaces the instance, so a reference change triggers a
   *  restyle on the next update (picked up by the 5s tick within 5s). */
  let lastTheme: Theme | undefined;

  const statusText = (): string => {
    const { input, output } = scanner.totals;
    return `Σ↑${formatTokens(input)} Σ↓${formatTokens(output)} (global)`;
  };

  /**
   * Push the cached text to the footer; no-op when neither the value nor the
   * theme changed. Styled with theme.fg("dim", ...) — the same token the
   * built-in footer applies to the session-stats line above, so the global
   * counter matches its color.
   */
  const applyStatus = (): void => {
    const ctx = activeCtx;
    if (!ctx) return;
    if (!enabled || ctx.mode !== "tui") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      lastText = "";
      lastTheme = undefined;
      return;
    }
    const plain = statusText();
    const theme = ctx.ui.theme;
    if (plain === lastText && theme === lastTheme) return;
    ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", plain));
    lastText = plain;
    lastTheme = theme;
  };

  /** Schedule an async scan. Coalesces into at most one in-flight scan. */
  const scanNow = (): void => {
    if (scanInFlight) {
      scanPending = true;
      return;
    }
    const gen = generation;
    scanInFlight = scanner
      .scan(sessionsDir)
      .catch(() => undefined) // transient fs error: keep last good totals
      .finally(() => {
        scanInFlight = undefined;
        if (scanPending) {
          scanPending = false;
          scanNow();
          return;
        }
        if (gen === generation) applyStatus();
      });
  };

  const startInterval = (): void => {
    if (interval) return;
    interval = setInterval(scanNow, RESCAN_INTERVAL_MS);
    interval.unref?.(); // never keep the process alive
  };

  const stopInterval = (): void => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  pi.registerCommand("token-counter", {
    description: "Toggle the global (all-sessions) token counter in the footer",
    handler: async (_args, ctx) => {
      trackExtensionRun(import.meta.url); // /stats global usage counter
      enabled = !enabled;
      activeCtx = ctx;
      applyStatus();
      ctx.ui.notify(`Global token counter ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    generation += 1; // invalidate in-flight scans from the previous session
    activeCtx = ctx;
    if (ctx.mode !== "tui") {
      stopInterval();
      return;
    }
    scanNow(); // full (or delta) scan, async — footer updates when it lands
    startInterval();
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeCtx = ctx;
    scanNow(); // the session file just gained the new assistant usage
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeCtx = ctx;
    scanNow(); // compaction entries carry their own usage
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeCtx = ctx;
    scanNow(); // branch summaries carry usage
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeCtx = ctx;
    scanNow(); // the resumed session file may be new to us
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    generation += 1;
    stopInterval();
    activeCtx = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
