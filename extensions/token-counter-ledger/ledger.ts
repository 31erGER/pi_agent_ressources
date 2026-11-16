/**
 * token-counter ledger — generation-time token accounting for the global counter.
 *
 * The ledger is an append-only JSONL file: <agent dir>/token-ledger.jsonl.
 * One line is written the moment pi reports usage for an LLM call (turn_end /
 * session_compact / session_tree events), plus exactly ONE seed line that
 * migrates the pre-existing history (all session files in sessions/ and
 * discarded-sessions/, i.e. also previously nuked sessions) on the first
 * start after the extension update.
 *
 * Ledger line formats (reader skips lines that do not parse):
 *   turn:      {"t":"<iso>","m":"<provider>/<model>","i":<in>,"o":<out>}
 *   compaction:{"t":"<iso>","kind":"compact","i":<in>,"o":<out>}
 *   branch:    {"t":"<iso>","kind":"branch","i":<in>,"o":<out>}
 *   seed:      {"t":"<iso>","seed":true,"i":<in>,"o":<out>,"files":<n>}
 *
 * This is a HELPER MODULE, not a pi extension: it lives in a subdirectory of
 * ~/.pi/agent/extensions/ WITHOUT index.ts, which pi's extension discovery
 * silently skips (see loader.js discoverExtensionsInDir). Do NOT move it to
 * the top level of extensions/.
 *
 * Concurrency: appends are single small writes (< 200 B) with O_APPEND and
 * are atomic on Linux; multiple pi processes may append safely. The seed is
 * serialized with a mkdir lock (<agent dir>/.token-ledger.lock); stale locks
 * (older than 2 minutes) are taken over.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Dirent, Stats } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Totals {
  input: number;
  output: number;
}

export interface AppendEntry {
  input: number;
  output: number;
  /** "provider/model" — turn lines only. */
  model?: string;
  /** Distinguishes compaction / branch-summary lines. */
  kind?: "compact" | "branch";
}

export type SeedResult = "seeded" | "already" | "locked";

const LEDGER_FILE_NAME = "token-ledger.jsonl";
const LOCK_DIR_NAME = ".token-ledger.lock";
const LOCK_STALE_MS = 2 * 60 * 1000;
/** The seed line is the first line of a fresh ledger; a bounded head read is enough. */
const SEED_PROBE_BYTES = 64 * 1024;
const MAX_WALK_DEPTH = 4;
const SEED_DIRS = ["sessions", "discarded-sessions"];

/** Default ledger path; pass agentDir explicitly in tests (PI_CODING_AGENT_DIR). */
export function ledgerPath(agentDir: string = getAgentDir()): string {
  return path.join(agentDir, LEDGER_FILE_NAME);
}

/**
 * Extract the provider-reported input/output usage of one session-file entry.
 * Same semantics as the pre-rewrite token-counter scanner: assistant
 * messages plus compaction / branch_summary / usage entries.
 */
function usageOf(entry: unknown): { input?: number; output?: number } | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, any>;
  if (e.type === "message") {
    const msg = e.message;
    if (msg && msg.role === "assistant" && msg.usage) {
      return { input: msg.usage.input, output: msg.usage.output };
    }
    return undefined;
  }
  if (e.type === "compaction" || e.type === "branch_summary" || e.type === "usage") {
    return e.usage ? { input: e.usage.input, output: e.usage.output } : undefined;
  }
  return undefined;
}

async function findSessionFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSessionFiles(p, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(p);
    }
  }
  return files;
}

/**
 * Sum the usage of one whole session file. Compaction is transparent: entries
 * compacted out of the *context* remain on disk and are counted here.
 * Malformed lines are skipped.
 */
export async function sumSessionFile(file: string): Promise<Totals> {
  const raw = await fsp.readFile(file, "utf8");
  let input = 0;
  let output = 0;
  for (const line of raw.split("\n")) {
    if (!line || !line.includes('"usage"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = usageOf(entry);
    if (!usage) continue;
    if (typeof usage.input === "number") input += usage.input;
    if (typeof usage.output === "number") output += usage.output;
  }
  return { input, output };
}

/** One-shot full scan of one or more session directories (used only by the seed). */
export async function sumSessionFiles(dirs: string[]): Promise<Totals & { files: number }> {
  let input = 0;
  let output = 0;
  let files = 0;
  for (const dir of dirs) {
    for (const file of await findSessionFiles(dir)) {
      try {
        const t = await sumSessionFile(file);
        input += t.input;
        output += t.output;
        files += 1;
      } catch {
        // unreadable/corrupt file: skip
      }
    }
  }
  return { input, output, files };
}

/**
 * Append one usage line to the ledger (single O_APPEND write — atomic,
 * multi-process safe). All-zero usage is a no-op. Errors are logged, never thrown.
 */
export async function appendUsage(entry: AppendEntry, agentDir?: string): Promise<void> {
  const { input, output } = entry;
  if (!input && !output) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    ...(entry.model ? { m: entry.model } : {}),
    ...(entry.kind ? { kind: entry.kind } : {}),
    i: input,
    o: output,
  });
  try {
    await fsp.appendFile(ledgerPath(agentDir), line + "\n", "utf8");
  } catch (err) {
    console.error(`[token-counter-ledger] append failed: ${err instanceof Error ? err.message : err}`);
  }
}

interface LedgerMemo {
  path: string;
  mtimeMs: number;
  size: number;
  input: number;
  output: number;
}
let memo: LedgerMemo | undefined;

/** Sum all ledger lines. Unparseable (e.g. torn) lines are skipped. Memoized on (mtime, size). */
export async function sumLedger(agentDir?: string): Promise<Totals> {
  const p = ledgerPath(agentDir);
  let stat: Stats;
  try {
    stat = await fsp.stat(p);
  } catch {
    memo = undefined;
    return { input: 0, output: 0 };
  }
  if (memo && memo.path === p && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) {
    return { input: memo.input, output: memo.output };
  }
  const raw = await fsp.readFile(p, "utf8");
  let input = 0;
  let output = 0;
  for (const line of raw.split("\n")) {
    if (!line || !line.includes('"o"')) continue;
    let l: any;
    try {
      l = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof l.i === "number") input += l.i;
    if (typeof l.o === "number") output += l.o;
  }
  memo = { path: p, mtimeMs: stat.mtimeMs, size: stat.size, input, output };
  return { input, output };
}

/**
 * One-time migration: sum all existing session files (sessions/ +
 * discarded-sessions/) into a single seed line. Exactly-once: the seed line
 * marks completion; an mkdir lock serializes concurrent first starts.
 */
export async function seedIfNeeded(agentDir: string = getAgentDir()): Promise<SeedResult> {
  const p = ledgerPath(agentDir);

  const hasSeed = async (): Promise<boolean> => {
    try {
      const handle = await fsp.open(p, "r");
      try {
        const buf = Buffer.alloc(SEED_PROBE_BYTES);
        const { bytesRead } = await handle.read(buf, 0, SEED_PROBE_BYTES, 0);
        return buf.subarray(0, bytesRead).toString("utf8").includes('"seed":true');
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  };

  if (await hasSeed()) return "already";

  const lock = path.join(agentDir, LOCK_DIR_NAME);
  try {
    await fsp.mkdir(lock);
  } catch (err: any) {
    if (err?.code !== "EEXIST") return "locked";
    try {
      const st = await fsp.stat(lock);
      if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return "locked";
      await fsp.rmdir(lock);
      await fsp.mkdir(lock);
    } catch {
      return "locked";
    }
  }

  try {
    if (await hasSeed()) return "already"; // another start finished while we waited
    const totals = await sumSessionFiles(SEED_DIRS.map((d) => path.join(agentDir, d)));
    const line = JSON.stringify({
      t: new Date().toISOString(),
      seed: true,
      i: totals.input,
      o: totals.output,
      files: totals.files,
    });
    await fsp.appendFile(p, line + "\n", "utf8");
    return "seeded";
  } finally {
    await fsp.rmdir(lock).catch(() => undefined);
  }
}
