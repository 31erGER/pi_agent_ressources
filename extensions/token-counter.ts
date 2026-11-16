/**
 * Global token counter
 *
 * Shows all-time cumulative input/output tokens generated through pi in the
 * footer — e.g. Σ↑12.3M Σ↓1.8M (global).
 *
 * Data source: the append-only ledger <agent dir>/token-ledger.jsonl. One line
 * is appended the moment pi reports usage for an LLM call:
 *   turn_end        -> event.message.usage           (every assistant response)
 *   session_compact -> event.compactionEntry.usage   (compaction summary calls)
 *   session_tree    -> event.summaryEntry?.usage     (branch summary calls)
 * Compaction never hides tokens: compacted-out messages stay on disk (the
 * one-time seed below counts them) and the compaction call itself is recorded.
 *
 * Migration: the first start appends ONE seed line with the sum of all
 * existing session files (sessions/ + discarded-sessions/, i.e. also
 * previously nuked sessions). From then on, session files are never read
 * again, so nuking / deleting / restoring / resuming sessions cannot affect
 * the total.
 *
 * Notes:
 *   - Recording happens in all modes (tui + rpc) and is independent of the
 *     display toggle: /token-counter only hides/shows the footer line.
 *   - Usage numbers are the provider-reported input/output per call — same
 *     semantics as the per-session ↑/↓ in the built-in footer.
 *   - Cache-warming calls (cloud providers with prompt caching) are NOT
 *     counted: they never touch a local GPU and local models do not do cache
 *     warming.
 *   - The ledger is append-only and never compacted (~1 MB/year of heavy use).
 *
 * Loaded automatically from ~/.pi/agent/extensions/.
 *   /token-counter  show/hide the counter line in the footer
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { trackExtensionRun } from "./stats.ts"; // global usage counter (stats extension)
import { appendUsage, seedIfNeeded, sumLedger, type Totals } from "./token-counter-ledger/ledger.ts";

const STATUS_KEY = "global_tokens";
const RESCAN_INTERVAL_MS = 5_000; // pick up appends from other pi processes

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let enabled = true;
  let activeCtx: ExtensionContext | undefined;
  let generation = 0;
  let totals: Totals = { input: 0, output: 0 };
  let scanInFlight: Promise<void> | undefined;
  let scanPending = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastText = "";
  let lastTheme: Theme | undefined;

  const statusText = (): string =>
    `Σ↑${formatTokens(totals.input)} Σ↓${formatTokens(totals.output)} (global)`;

  const applyStatus = (): void => {
    const ctx = activeCtx;
    if (!ctx) return;
    const text = statusText();
    const theme = ctx.ui.theme;
    if (text === lastText && theme === lastTheme) return;
    lastText = text;
    lastTheme = theme;
    if (!enabled) {
      ctx.ui.setStatus(STATUS_KEY, "");
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", text));
  };

  // Re-read the ledger and refresh the footer line. Rescans are coalesced:
  // one in-flight at a time, at most one queued.
  const scanNow = (): void => {
    if (scanInFlight) {
      scanPending = true;
      return;
    }
    const gen = generation;
    scanInFlight = sumLedger(agentDir)
      .then((t) => {
        totals = t;
      })
      .catch(() => undefined)
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
    if (!interval) interval = setInterval(scanNow, RESCAN_INTERVAL_MS);
  };

  const stopInterval = (): void => {
    if (interval) clearInterval(interval);
    interval = undefined;
  };

  // ---- Recording (all modes, independent of the display toggle) ----

  const record = async (
    input: number,
    output: number,
    extra: { model?: string; kind?: "compact" | "branch" } = {},
  ): Promise<void> => {
    await appendUsage({ input, output, ...extra }, agentDir);
    if (activeCtx?.mode === "tui") scanNow();
  };

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.mode === "tui") activeCtx = ctx;
    const message = event.message;
    if (message && message.role === "assistant" && message.usage) {
      await record(message.usage.input, message.usage.output, {
        model: `${message.provider}/${message.model}`,
      });
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    if (ctx.mode === "tui") activeCtx = ctx;
    const usage = event.compactionEntry?.usage;
    if (usage) await record(usage.input, usage.output, { kind: "compact" });
  });

  pi.on("session_tree", async (event, ctx) => {
    if (ctx.mode === "tui") activeCtx = ctx;
    const usage = event.summaryEntry?.usage;
    if (usage) await record(usage.input, usage.output, { kind: "branch" });
  });

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    activeCtx = ctx;
    // One-time migration of the pre-existing history (all modes). The first
    // start after the update pays a full scan of the session dirs; afterwards
    // this is a bounded head-read of the ledger. Awaiting it here closes the
    // race where a first turn would be counted by both the seed and the ledger.
    await seedIfNeeded(agentDir).catch(() => undefined);
    if (ctx.mode !== "tui") {
      stopInterval();
      return;
    }
    scanNow();
    startInterval();
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    if (ctx.mode === "tui") scanNow();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    generation += 1;
    if (ctx.mode === "tui") {
      stopInterval();
      activeCtx = undefined;
      lastText = "";
      lastTheme = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.registerCommand("token-counter", {
    description: "Show/hide the global token counter in the footer",
    handler: async (args: string, ctx: ExtensionContext) => {
      enabled = !enabled || args === "on";
      ctx.ui.notify(`Global token counter ${enabled ? "enabled" : "disabled"}`);
      applyStatus();
      trackExtensionRun("token-counter");
    },
  });
}
