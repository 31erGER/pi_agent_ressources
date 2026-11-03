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
 * Auto-loaded from ~/.pi/agent/extensions/. Pure core (startTurn/addUsage/
 * finishTurn/formatters) is exported and unit-tested in
 * ~/.pi/agent/projects/turn-stats/test/turn-stats.test.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  /** Currently tracked turn, or null when idle. */
  let turn: TurnTracker | null = null;

  pi.on("agent_start", () => {
    // A continuation (retry / auto-compaction / queued follow-up) starts a new
    // low-level run for the SAME turn: keep the existing accumulator.
    if (!turn) turn = startTurn(Date.now());
  });

  pi.on("message_end", (event) => {
    if (!turn) return;
    const m = event.message;
    if (m && m.role === "assistant") addUsage(turn, m.usage);
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!turn) return;
    const t = turn;
    turn = null;
    if (t.modelCalls === 0) return; // run produced no model usage — nothing to report
    if (!ctx.hasUI) return; // print/json mode: no chat transcript to render into
    pi.appendEntry(CUSTOM_TYPE, finishTurn(t, Date.now(), event.aborted === true));
  });

  // A session switch/quit/reload mid-run must not leak the in-flight accumulator.
  pi.on("session_shutdown", () => {
    turn = null;
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
