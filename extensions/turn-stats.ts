/**
 * turn-stats — quick per-turn stats line in the chat.
 *
 * After every turn (a full run: user prompt -> agent idle) it prints one dim
 * line into the chat transcript, e.g.:
 *
 *   ⏱ 42.3s · ↑ 12,340 in · ↓ 567 out · 13.4 tok/s · $0.0042 · 14:32:05
 *
 *   (aborted runs get an "· aborted" suffix; cost is omitted when it is 0;
 *    expanding the line shows cache-read tokens, start time and model-call count)
 *
 * Semantics:
 *   - "turn" = one full agent run, i.e. everything between the user prompt and
 *     `agent_settled` (the true end, after retries / auto-compaction / queued
 *     follow-ups). `agent_end` alone is NOT final: a low-level run can end and
 *     another one can start for the same turn, so the accumulator only resets
 *     on `agent_start` when no turn is currently tracked.
 *   - tokens: raw `usage.input` / `usage.output` per assistant message, same
 *     semantics as pi's built-in footer (cache read is excluded from "in" and
 *     only shown in the expanded view).
 *   - tok/s: output tokens / turn duration (generation speed).
 *
 * Display-only, LLM-invisible: stats are appended with pi.appendEntry() (custom
 * entries do NOT participate in LLM context) and drawn by a
 * pi.registerEntryRenderer() renderer. Nothing is sent to the model, no entry
 * is written for runs without assistant usage, and nothing is appended in
 * print/json mode (no chat to render into).
 *
 * v2 — live stats while the turn runs: a sticky one-line widget above the
 * chat input (ctx.ui.setWidget, default placement) updated by a 250 ms
 * ticker shows elapsed time, tokens so far and tok/s so far. In-flight
 * tokens come from the streaming partial message's usage when the provider
 * reports it (message_start/message_update); otherwise the line only moves
 * when a message completes. The widget is cleared on agent_settled /
 * session_shutdown — the ticker interval is always stopped, so it can never
 * keep the process alive.
 *
 * v3 — thinking statement: right after each thinking block ends (pi-ai
 * stream events thinking_start/thinking_end on message_update) a dim chat
 * entry (custom type "turn-thinking", LLM-invisible) reports how long the
 * model thought and how many tokens the thinking cost, e.g.
 *   🧠 thought 12.4s · ≈1,234 thinking tok
 * Providers only fill usage.reasoning from the FINAL usage chunk, so at
 * thinking_end the exact count is normally unknown: the statement uses
 * usage.reasoning when the provider already reported it, otherwise an
 * estimate (house chars/4 heuristic) of the block's full text, marked with
 * "≈". A thinking block cut off by an abort gets a "truncated" statement
 * with the duration only.
 *
 * Auto-loaded from ~/.pi/agent/extensions/. Pure core (startTurn/addUsage/
 * finishTurn/liveStats/formatters) is exported and unit-tested in
 * ~/.pi/agent/projects/turn-stats/test/turn-stats.test.ts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

/** Usage subset as reported on assistant messages (pi-ai Usage). */
export interface TurnUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: { total?: number };
}

/** Mutable per-turn accumulator (one per tracked run). */
export interface TurnTracker {
  startedAt: number;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  modelCalls: number;
}

/** Immutable stats for one finished turn (stored as custom-entry data). */
export interface TurnStatsData {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  modelCalls: number;
  aborted: boolean;
}

const CUSTOM_TYPE = "turn-stats";
const THINKING_TYPE = "turn-thinking";
const WIDGET_KEY = "turn-stats";

// ── Pure core (unit-tested) ──────────────────────────────────────────────────

export function startTurn(now: number): TurnTracker {
  return { startedAt: now, input: 0, output: 0, cacheRead: 0, cost: 0, modelCalls: 0 };
}

/**
 * Accumulate one assistant message's usage.
 * No-op when no usage was reported (null/undefined or an object without any
 * numeric fields) — such a message must not count as a model call.
 */
export function addUsage(t: TurnTracker, u: TurnUsageLike | null | undefined): void {
  if (!u || (u.input === undefined && u.output === undefined && u.cacheRead === undefined && !u.cost)) return;
  t.input += u.input ?? 0;
  t.output += u.output ?? 0;
  t.cacheRead += u.cacheRead ?? 0;
  t.cost += u.cost?.total ?? 0;
  t.modelCalls += 1;
}

export function finishTurn(t: TurnTracker, now: number, aborted: boolean): TurnStatsData {
  return {
    startedAt: t.startedAt,
    finishedAt: now,
    durationMs: Math.max(0, now - t.startedAt),
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cost: t.cost,
    modelCalls: t.modelCalls,
    aborted,
  };
}

/** Output tokens per second (generation speed). 0 for non-positive durations. */
export function tokensPerSec(d: Pick<TurnStatsData, "output" | "durationMs">): number {
  if (d.durationMs <= 0) return 0;
  return d.output / (d.durationMs / 1000);
}

/** 0..999ms -> "<1s"; <60s -> "42.3s"; else "1m 23s" / "1m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** $0.00 when <= 0; 4 decimals under $1 (typical per-turn cost); 2 otherwise. */
export function formatCost(c: number): string {
  if (c <= 0) return "$0.00";
  return `$${c < 1 ? c.toFixed(4) : c.toFixed(2)}`;
}

/** 24h wall clock, e.g. "14:32:05". */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

/** The one-line chat rendering of a finished turn. */
export function formatTurnLine(d: TurnStatsData): string {
  const parts = [
    `⏱ ${formatDuration(d.durationMs)}`,
    `↑ ${formatNumber(d.input)} in`,
    `↓ ${formatNumber(d.output)} out`,
    `${tokensPerSec(d).toFixed(1)} tok/s`,
  ];
  if (d.cost > 0) parts.push(formatCost(d.cost));
  parts.push(formatClock(d.finishedAt));
  if (d.aborted) parts.push("aborted");
  return parts.join(" · ");
}

/** Live snapshot of the turn in progress (completed usage + in-flight partial). */
export interface LiveTurnStats {
  elapsedMs: number;
  input: number;
  output: number;
  tokensPerSec: number;
}

export function liveStats(t: TurnTracker, now: number, live: TurnUsageLike | null = null): LiveTurnStats {
  const elapsedMs = Math.max(0, now - t.startedAt);
  const input = t.input + (live?.input ?? 0);
  const output = t.output + (live?.output ?? 0);
  return { elapsedMs, input, output, tokensPerSec: elapsedMs <= 0 ? 0 : output / (elapsedMs / 1000) };
}

/** The sticky one-line widget rendering of the turn in progress. */
export function formatLiveLine(s: LiveTurnStats): string {
  return `⏱ ${formatDuration(s.elapsedMs)} · ↑ ${formatNumber(s.input)} in · ↓ ${formatNumber(s.output)} out · ${s.tokensPerSec.toFixed(1)} tok/s`;
}

/** Stats for one finished thinking block (stored as custom-entry data). */
export interface ThinkingStatsData {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** Thinking tokens: exact (provider-reported) or estimated, null if unknown. */
  tokens: number | null;
  /** True when tokens came from the chars/4 estimate of the thinking text. */
  estimated: boolean;
  /** True when the block was cut off (abort) before its thinking_end. */
  truncated: boolean;
}

/** House token heuristic (pi core's estimateTokens: ceil(chars / 4)). */
export function estimateThinkingTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function thinkingStats(
  startedAt: number,
  endedAt: number,
  exactTokens: number | null | undefined,
  thinkingText: string | null,
  truncated = false,
): Omit<ThinkingStatsData, "startedAt" | "finishedAt"> {
  const durationMs = Math.max(0, endedAt - startedAt);
  if (exactTokens != null) return { durationMs, tokens: exactTokens, estimated: false, truncated };
  if (thinkingText) return { durationMs, tokens: estimateThinkingTokens(thinkingText), estimated: true, truncated };
  return { durationMs, tokens: null, estimated: false, truncated };
}

/** The one-line chat rendering of a finished thinking block. */
export function formatThinkingLine(s: Pick<ThinkingStatsData, "durationMs" | "tokens" | "estimated" | "truncated">): string {
  const parts = [`🧠 thought ${formatDuration(s.durationMs)}`];
  if (s.tokens != null) parts.push(`${s.estimated ? "≈" : ""}${formatNumber(s.tokens)} thinking tok`);
  if (s.truncated) parts.push("truncated");
  return parts.join(" · ");
}

// ── Extension ────────────────────────────────────────────────────────────────

export interface TurnStatsOptions {
  /** Ticker interval for the live widget (tests use small values). Default 250 ms. */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 250;

export default function (pi: ExtensionAPI, options: TurnStatsOptions = {}): void {
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;

  /** Currently tracked turn, or null when idle. */
  let turn: TurnTracker | null = null;
  /** Usage of the in-flight assistant message, when the provider streams it. */
  let liveUsage: TurnUsageLike | null = null;
  /** Start time of the in-flight thinking block, or null (v3). */
  let thinkingStartedAt: number | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastCtx: ExtensionContext | null = null;
  let lastLine: string | null = null;

  const refresh = (ctx: ExtensionContext): void => {
    if (!turn || !ctx.hasUI) return;
    const line = formatLiveLine(liveStats(turn, Date.now(), liveUsage));
    if (line !== lastLine) { // don't re-set the widget unless something changed
      lastLine = line;
      ctx.ui.setWidget(WIDGET_KEY, [line]);
    }
  };

  /** Append the thinking statement for one finished block (v3). */
  const emitThinking = (ctx: ExtensionContext, stats: Omit<ThinkingStatsData, "startedAt" | "finishedAt">, startedAt: number, finishedAt: number): void => {
    if (!ctx.hasUI) return; // print/json mode: no chat transcript to render into
    pi.appendEntry(THINKING_TYPE, { startedAt, finishedAt, ...stats });
  };

  const startTicker = (ctx: ExtensionContext): void => {
    if (ticker || !ctx.hasUI) return;
    lastCtx = ctx;
    lastLine = null;
    refresh(ctx);
    ticker = setInterval(() => refresh(lastCtx ?? ctx), tickMs);
  };

  const stopTicker = (ctx: ExtensionContext): void => {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    lastLine = null;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined); // remove the sticky line
  };

  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    // A continuation (retry / auto-compaction / queued follow-up) starts a new
    // low-level run for the SAME turn: keep the existing accumulator + ticker.
    if (!turn) {
      turn = startTurn(Date.now());
      liveUsage = null;
      thinkingStartedAt = null;
      startTicker(ctx);
    }
  });

  pi.on("message_start", (event, ctx) => {
    lastCtx = ctx;
    const m = event.message;
    if (!turn) return;
    // New assistant message: drop the previous in-flight usage; keep whatever
    // the provider already reported on the partial (e.g. Anthropic input tokens).
    if (m && m.role === "assistant") {
      liveUsage = m.usage ?? null;
      thinkingStartedAt = null; // a new model call never inherits a thinking span
    }
  });

  pi.on("message_update", (event, ctx) => {
    lastCtx = ctx;
    const m = event.message;
    if (!turn) return;
    // High-frequency: only capture, never render (the ticker does that).
    if (m && m.role === "assistant" && m.usage) liveUsage = m.usage;
    // Thinking-block tracking (v3): only start/end matter, never per-delta.
    if (m && m.role === "assistant") {
      const se = event.assistantMessageEvent;
      if (se && se.type === "thinking_start") {
        thinkingStartedAt = Date.now();
      } else if (se && se.type === "thinking_end" && thinkingStartedAt != null) {
        const startedAt = thinkingStartedAt;
        const finishedAt = Date.now();
        thinkingStartedAt = null;
        // usage.reasoning is normally only set from the provider's FINAL usage
        // chunk, so prefer it when present and otherwise estimate from the
        // block's full text (carried by the thinking_end event).
        emitThinking(ctx, thinkingStats(startedAt, finishedAt, m.usage?.reasoning ?? null, se.content), startedAt, finishedAt);
      }
    }
  });

  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    if (!turn) return;
    const m = event.message;
    if (m && m.role === "assistant") {
      addUsage(turn, m.usage);
      liveUsage = null; // final usage is now in the tracker
      // Thinking block cut off before its thinking_end (e.g. abort).
      if (thinkingStartedAt != null) {
        const startedAt = thinkingStartedAt;
        const finishedAt = Date.now();
        thinkingStartedAt = null;
        emitThinking(ctx, thinkingStats(startedAt, finishedAt, m.usage?.reasoning ?? null, null, true), startedAt, finishedAt);
      }
    }
  });

  pi.on("agent_settled", (event, ctx) => {
    lastCtx = ctx;
    stopTicker(ctx);
    if (!turn) return;
    const t = turn;
    turn = null;
    liveUsage = null;
    if (t.modelCalls === 0) return; // run produced no model usage — nothing to report
    if (!ctx.hasUI) return; // print/json mode: no chat transcript to render into
    pi.appendEntry(CUSTOM_TYPE, finishTurn(t, Date.now(), event.aborted === true));
  });

  // A session switch/quit/reload mid-run must not leak the accumulator, the
  // in-flight usage, the thinking span or the ticker interval (or pi would
  // not exit).
  pi.on("session_shutdown", (_event, ctx) => {
    stopTicker(ctx);
    turn = null;
    liveUsage = null;
    thinkingStartedAt = null;
  });

  pi.registerEntryRenderer<ThinkingStatsData>(THINKING_TYPE, (entry, _opts, theme) => {
    const data = entry.data;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    if (!data) {
      box.addChild(new Text(theme.fg("dim", "[turn-thinking: missing data]"), 0, 0));
      return box;
    }
    box.addChild(new Text(theme.fg("dim", formatThinkingLine(data)), 0, 0));
    return box;
  });

  pi.registerEntryRenderer<TurnStatsData>(CUSTOM_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    if (!data) {
      box.addChild(new Text(theme.fg("dim", "[turn-stats: missing data]"), 0, 0));
      return box;
    }
    box.addChild(new Text(theme.fg("dim", formatTurnLine(data)), 0, 0));
    if (expanded) {
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `cache read ${formatNumber(data.cacheRead)} · started ${formatClock(data.startedAt)} · ${data.modelCalls} model call${data.modelCalls === 1 ? "" : "s"}`,
          ),
          0,
          0,
        ),
      );
    }
    return box;
  });
}
