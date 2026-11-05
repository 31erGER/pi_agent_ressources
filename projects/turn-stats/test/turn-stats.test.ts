/**
 * Test suite for ~/.pi/agent/extensions/turn-stats.ts (per-turn quick stats line).
 *
 * Run:  node test/turn-stats.test.ts   (from ~/.pi/agent/projects/turn-stats)
 *
 * Node >= 23.6 (type stripping) runs this .ts file directly. Bare
 * @earendil-works/* imports resolve via the node_modules symlinks in
 * ~/.pi/agent/node_modules.
 *
 * Part 1: pure core (accumulation + formatting).
 * Part 2: integration — the real extension default export driven with a mock
 *          ExtensionAPI: agent_start -> message_end* -> agent_settled.
 */
process.env.TZ = "UTC"; // deterministic clock formatting (must run before any formatClock call)

import { Box } from "@earendil-works/pi-tui";
import turnStatsExt, {
  type TurnStatsData,
  addUsage,
  estimateThinkingTokens,
  formatThinkingLine,
  thinkingStats,
  finishTurn,
  formatClock,
  formatCost,
  formatDuration,
  formatLiveLine,
  formatNumber,
  formatTurnLine,
  liveStats,
  startTurn,
  tokensPerSec,
} from "../../../extensions/turn-stats.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let passed = 0;
function check(label: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed++;
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label} ${extra}`);
  }
}

const T0 = Date.parse("2025-11-03T14:31:00.000Z");
const T1 = Date.parse("2025-11-03T14:32:05.000Z"); // T0 + 42.3s later? -> 65s; used separately below

// ── Part 1: pure core ────────────────────────────────────────────────────────

// startTurn
{
  const t = startTurn(T0);
  check(
    "startTurn: zeroed accumulator at startedAt",
    t.startedAt === T0 && t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cost === 0 && t.modelCalls === 0,
    JSON.stringify(t),
  );
}

// addUsage
{
  const t = startTurn(T0);
  addUsage(t, { input: 100, output: 10, cacheRead: 50, cost: { total: 0.001 } });
  addUsage(t, { input: 200, output: 20, cacheRead: 70 });
  check(
    "addUsage: sums input/output/cacheRead/cost across messages",
    t.input === 300 && t.output === 30 && t.cacheRead === 120 && t.cost === 0.001 && t.modelCalls === 2,
    JSON.stringify(t),
  );
  const before = { ...t };
  addUsage(t, null);
  addUsage(t, undefined);
  addUsage(t, {});
  check(
    "addUsage: null/undefined/{} are no-ops (no modelCall counted)",
    JSON.stringify(t) === JSON.stringify(before),
    JSON.stringify(t),
  );
}

// finishTurn
{
  const t = startTurn(T0);
  addUsage(t, { input: 100, output: 30, cost: { total: 0.01 } });
  const d = finishTurn(t, T0 + 42_300, false);
  check(
    "finishTurn: maps tracker to data with durationMs",
    d.startedAt === T0 && d.finishedAt === T0 + 42_300 && d.durationMs === 42_300 &&
      d.input === 100 && d.output === 30 && d.cacheRead === 0 && d.cost === 0.01 &&
      d.modelCalls === 1 && d.aborted === false,
    JSON.stringify(d),
  );
  check(
    "finishTurn: aborted flag carried through",
    finishTurn(startTurn(T0), T0, true).aborted === true,
  );
  check(
    "finishTurn: negative duration clamped to 0",
    finishTurn(startTurn(T0), T0 - 5000, false).durationMs === 0,
  );
}

// tokensPerSec
{
  const d: TurnStatsData = {
    startedAt: T0, finishedAt: T0 + 42_300, durationMs: 42_300,
    input: 12_340, output: 567, cacheRead: 0, cost: 0, modelCalls: 1, aborted: false,
  };
  check("tokensPerSec: output / seconds", Math.abs(tokensPerSec(d) - 567 / 42.3) < 1e-9, String(tokensPerSec(d)));
  check("tokensPerSec: zero duration -> 0", tokensPerSec({ ...d, durationMs: 0 }) === 0);
  check("tokensPerSec: negative duration -> 0", tokensPerSec({ ...d, durationMs: -3 }) === 0);
}

// formatDuration
{
  check("formatDuration: <1000ms", formatDuration(0) === "<1s" && formatDuration(999) === "<1s");
  check("formatDuration: seconds with 1 decimal", formatDuration(3_400) === "3.4s" && formatDuration(42_300) === "42.3s");
  check("formatDuration: minutes", formatDuration(60_000) === "1m" && formatDuration(83_500) === "1m 23s" && formatDuration(3_661_000) === "61m 1s");
}

// formatNumber
{
  check("formatNumber: grouping", formatNumber(0) === "0" && formatNumber(567) === "567" &&
    formatNumber(1_234) === "1,234" && formatNumber(1_234_567) === "1,234,567");
}

// formatCost
{
  check("formatCost: zero", formatCost(0) === "$0.00" && formatCost(-1) === "$0.00");
  check("formatCost: tiny -> 4 decimals", formatCost(0.00423) === "$0.0042");
  check("formatCost: normal -> 2 decimals", formatCost(0.1234) === "$0.1234" && formatCost(12.345) === "$12.35");
}

// formatClock
{
  check("formatClock: 24h UTC", formatClock(T1) === "14:32:05", formatClock(T1));
}

// formatTurnLine
{
  const base: TurnStatsData = {
    startedAt: T0, finishedAt: T1, durationMs: T1 - T0, // 65s
    input: 12_340, output: 567, cacheRead: 100, cost: 0.00423, modelCalls: 2, aborted: false,
  };
  // 567 out / 65s = 8.72... -> "8.7 tok/s"
  check(
    "formatTurnLine: all required stats present",
    formatTurnLine(base) === `⏱ 1m 5s · ↑ 12,340 in · ↓ 567 out · 8.7 tok/s · $0.0042 · 14:32:05`,
    formatTurnLine(base),
  );
  check(
    "formatTurnLine: cost segment omitted when 0",
    formatTurnLine({ ...base, cost: 0 }) === `⏱ 1m 5s · ↑ 12,340 in · ↓ 567 out · 8.7 tok/s · 14:32:05`,
    formatTurnLine({ ...base, cost: 0 }),
  );
  check(
    "formatTurnLine: aborted marker appended",
    formatTurnLine({ ...base, aborted: true }).endsWith(" · aborted"),
    formatTurnLine({ ...base, aborted: true }),
  );
}

// liveStats (v2)
{
  const t = startTurn(T0);
  addUsage(t, { input: 1000, output: 200 });
  const s = liveStats(t, T0 + 10_000, { input: 500, output: 50 });
  check(
    "liveStats: sums completed + in-flight usage, elapsed + tps",
    s.elapsedMs === 10_000 && s.input === 1500 && s.output === 250 && Math.abs(s.tokensPerSec - 25) < 1e-9,
    JSON.stringify(s),
  );
  const s0 = liveStats(t, T0, null);
  check(
    "liveStats: zero elapsed -> 0 tps, no live usage",
    s0.elapsedMs === 0 && s0.tokensPerSec === 0 && s0.input === 1000 && s0.output === 200,
    JSON.stringify(s0),
  );
  const s2 = liveStats(t, T0 - 5000, { output: 7 });
  check("liveStats: negative elapsed clamped, tps 0", s2.elapsedMs === 0 && s2.tokensPerSec === 0 && s2.output === 207);
}

// formatLiveLine (v2)
{
  const line = formatLiveLine({ elapsedMs: 12_400, input: 12_340, output: 567, tokensPerSec: 45.7 });
  check(
    "formatLiveLine: exact line",
    line === "⏱ 12.4s · ↑ 12,340 in · ↓ 567 out · 45.7 tok/s",
    line,
  );
  check(
    "formatLiveLine: sub-second elapsed",
    formatLiveLine({ elapsedMs: 900, input: 10, output: 2, tokensPerSec: 0 }) === "⏱ <1s · ↑ 10 in · ↓ 2 out · 0.0 tok/s",
    formatLiveLine({ elapsedMs: 900, input: 10, output: 2, tokensPerSec: 0 }),
  );
}

// estimateThinkingTokens (v3)
{
  check("estimateThinkingTokens: house chars/4 heuristic",
    estimateThinkingTokens("") === 0 &&
    estimateThinkingTokens("abc") === 1 &&
    estimateThinkingTokens("x".repeat(400)) === 100 &&
    estimateThinkingTokens("x".repeat(1001)) === 251);
}

// thinkingStats (v3)
{
  const s = thinkingStats(T0, T0 + 12_400, 999, "ignored text");
  check("thinkingStats: exact tokens win over estimate",
    s.durationMs === 12_400 && s.tokens === 999 && s.estimated === false && s.truncated === false,
    JSON.stringify(s));
  const e = thinkingStats(T0, T0 + 12_400, null, "x".repeat(400));
  check("thinkingStats: falls back to estimate (flagged)",
    e.tokens === 100 && e.estimated === true,
    JSON.stringify(e));
  const n = thinkingStats(T0, T0 + 8_200, null, null, true);
  check("thinkingStats: no data -> tokens null, truncated kept",
    n.tokens === null && n.estimated === false && n.truncated === true && n.durationMs === 8_200,
    JSON.stringify(n));
  check("thinkingStats: negative duration clamped", thinkingStats(T0, T0 - 5, 3, null).durationMs === 0);
}

// formatThinkingLine (v3)
{
  check("formatThinkingLine: exact tokens",
    formatThinkingLine({ durationMs: 12_400, tokens: 1234, estimated: false, truncated: false }) ===
      "🧠 thought 12.4s · 1,234 thinking tok");
  check("formatThinkingLine: estimated tokens marked ≈",
    formatThinkingLine({ durationMs: 12_400, tokens: 1234, estimated: true, truncated: false }) ===
      "🧠 thought 12.4s · ≈1,234 thinking tok");
  check("formatThinkingLine: truncated without tokens",
    formatThinkingLine({ durationMs: 8_200, tokens: null, estimated: false, truncated: true }) ===
      "🧠 thought 8.2s · truncated");
  check("formatThinkingLine: sub-second",
    formatThinkingLine({ durationMs: 900, tokens: 12, estimated: false, truncated: false }) ===
      "🧠 thought <1s · 12 thinking tok");
}

// ── Part 2: integration with a mock ExtensionAPI ─────────────────────────────

interface MockPi {
  on(event: string, handler: (...args: unknown[]) => unknown): () => void;
  appendEntry(customType: string, data?: unknown): void;
  registerEntryRenderer(customType: string, renderer: (...args: unknown[]) => unknown): void;
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  entries: Array<{ customType: string; data: unknown }>;
  renderer: ((...args: unknown[]) => unknown) | null;
  widgetCalls: Array<{ key: string; value: unknown }>;
  ctx: { hasUI: boolean; ui: { setWidget(key: string, value: unknown, options?: unknown): void } };
}

function makeMockPi(hasUI: boolean): MockPi {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const widgetCalls: Array<{ key: string; value: unknown }> = [];
  const pi: MockPi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const l = handlers.get(event);
        const i = l?.indexOf(handler) ?? -1;
        if (i >= 0) l!.splice(i, 1);
      };
    },
    appendEntry(customType, data) {
      pi.entries.push({ customType, data });
    },
    registerEntryRenderer(_customType, renderer) {
      pi.renderer = renderer;
    },
    handlers,
    entries: [],
    renderer: null,
    widgetCalls,
    ctx: {
      hasUI,
      ui: {
        setWidget(key: string, value: unknown) {
          widgetCalls.push({ key, value });
        },
      },
    },
  };
  return pi;
}

async function fire(pi: MockPi, event: string, ...args: unknown[]): Promise<void> {
  const ctx = pi.ctx;
  for (const h of pi.handlers.get(event) ?? []) {
    const r = h(...args, ctx);
    if (r && typeof (r as Promise<unknown>).then === "function") await r;
  }
}

function assistantMsg(usage: unknown): { role: "assistant"; usage?: unknown } {
  return { role: "assistant", ...(usage === undefined ? {} : { usage }) };
}

const theme = {
  bg: (_key: string, text: string) => text,
  fg: (_key: string, text: string) => text,
  bold: (text: string) => text,
};

{
  // happy path: one run, two assistant messages, one user message in between
  const pi = makeMockPi(true);
  turnStatsExt(pi as never);
  check("registers agent_start/message_end/agent_settled handlers",
    (pi.handlers.get("agent_start")?.length ?? 0) === 1 &&
    (pi.handlers.get("message_end")?.length ?? 0) === 1 &&
    (pi.handlers.get("agent_settled")?.length ?? 0) === 1);
  check("registers an entry renderer", typeof pi.renderer === "function");

  await fire(pi, "agent_start", {});
  await fire(pi, "message_end", { message: assistantMsg({ input: 1000, output: 100, cacheRead: 50, cost: { total: 0.001 } }) });
  await fire(pi, "message_end", { message: { role: "user" } }); // ignored
  await fire(pi, "message_end", { message: assistantMsg({ input: 2000, output: 200, cacheRead: 70, cost: { total: 0.002 } }) });
  check("nothing appended before agent_settled", pi.entries.length === 0);

  await fire(pi, "agent_settled", { aborted: false });
  check("exactly one entry appended at settle", pi.entries.length === 1, JSON.stringify(pi.entries));
  const data = pi.entries[0]?.data as TurnStatsData | undefined;
  check("entry customType is turn-stats", pi.entries[0]?.customType === "turn-stats");
  check(
    "entry data sums usage across the run",
    !!data && data.input === 3000 && data.output === 300 && data.cacheRead === 120 &&
      Math.abs(data.cost - 0.003) < 1e-12 && data.modelCalls === 2 && data.aborted === false &&
      data.durationMs >= 0,
    JSON.stringify(data),
  );

  // a second run works again (state was reset at settle)
  await fire(pi, "agent_start", {});
  await fire(pi, "message_end", { message: assistantMsg({ input: 1, output: 1 }) });
  await fire(pi, "agent_settled", { aborted: false });
  check("second turn appends a second entry", pi.entries.length === 2 &&
    (pi.entries[1].data as TurnStatsData).input === 1 && (pi.entries[1].data as TurnStatsData).output === 1);
}

{
  // continuation: agent_end + agent_start again = same turn, ONE line, summed
  const pi = makeMockPi(true);
  turnStatsExt(pi as never);
  await fire(pi, "agent_start", {});
  await fire(pi, "message_end", { message: assistantMsg({ input: 100, output: 10 }) });
  await fire(pi, "agent_end", { messages: [] }); // low-level run ended, not settled
  await fire(pi, "agent_start", {}); // continuation of the SAME turn
  await fire(pi, "message_end", { message: assistantMsg({ input: 50, output: 5 }) });
  await fire(pi, "agent_settled", { aborted: false });
  const d = pi.entries[0]?.data as TurnStatsData | undefined;
  check("continuation: single entry with summed usage", pi.entries.length === 1 &&
    !!d && d.input === 150 && d.output === 15, JSON.stringify(pi.entries));
}

{
  // aborted run: still reported, flagged
  const pi = makeMockPi(true);
  turnStatsExt(pi as never);
  await fire(pi, "agent_start", {});
  await fire(pi, "message_end", { message: assistantMsg({ input: 10, output: 3 }) });
  await fire(pi, "agent_settled", { aborted: true });
  const d = pi.entries[0]?.data as TurnStatsData | undefined;
  check("aborted: entry present and flagged", pi.entries.length === 1 && d?.aborted === true, JSON.stringify(d));
}

{
  // run without any assistant usage -> no entry (no noise)
  const pi = makeMockPi(true);
  turnStatsExt(pi as never);
  await fire(pi, "agent_start", {});
  await fire(pi, "agent_settled", { aborted: false });
  check("no-usage run: nothing appended", pi.entries.length === 0, JSON.stringify(pi.entries));
}

{
  // print/json mode (hasUI=false) -> nothing appended
  const pi = makeMockPi(false);
  turnStatsExt(pi as never);
  await fire(pi, "agent_start", {});
  await fire(pi, "message_end", { message: assistantMsg({ input: 10, output: 3 }) });
  await fire(pi, "agent_settled", { aborted: false });
  check("hasUI=false: nothing appended", pi.entries.length === 0, JSON.stringify(pi.entries));
}

{
  // session_shutdown drops in-flight state; a stray settled then appends nothing
  const pi = makeMockPi(true);
  turnStatsExt(pi as never);
  await fire(pi, "agent_start", {});
  await fire(pi, "message_end", { message: assistantMsg({ input: 10, output: 3 }) });
  await fire(pi, "session_shutdown", { reason: "quit" });
  await fire(pi, "agent_settled", { aborted: true });
  check("session_shutdown: in-flight turn discarded", pi.entries.length === 0, JSON.stringify(pi.entries));
}

{
  // stray message_end with no active turn is ignored
  const pi = makeMockPi(true);
  turnStatsExt(pi as never);
  await fire(pi, "message_end", { message: assistantMsg({ input: 999, output: 999 }) });
  check("stray message_end ignored", pi.entries.length === 0);
}

{
  // renderer: returns a Box; dim line contains the stats; expanded view adds details
  const pi = makeMockPi(true);
  turnStatsExt(pi as never);
  const data: TurnStatsData = {
    startedAt: T0, finishedAt: T1, durationMs: T1 - T0,
    input: 12_340, output: 567, cacheRead: 123, cost: 0.00423, modelCalls: 2, aborted: false,
  };
  const render = pi.renderer as (entry: unknown, opts: unknown, theme: unknown) => unknown;
  const box = render({ customType: "turn-stats", data }, { expanded: false }, theme) as Box;
  check("renderer: returns a Box", box instanceof Box, String(box));
  const rendered = box.render(100).join("");
  check("renderer: line shows duration/tokens/tok-s",
    rendered.includes("1m 5s") && rendered.includes("↑ 12,340 in") && rendered.includes("↓ 567 out") && rendered.includes("tok/s"),
    rendered);
  const box2 = render({ customType: "turn-stats", data }, { expanded: true }, theme) as Box;
  const rendered2 = box2.render(100).join("");
  check("renderer: expanded view shows cache read + started",
    rendered2.includes("cache read 123") && rendered2.includes("model calls"), rendered2);
  const box3 = render({ customType: "turn-stats", data: undefined }, { expanded: false }, theme) as Box;
  check("renderer: missing data renders without throwing", box3 instanceof Box);
}

// live widget lifecycle (v2)
{
  const pi = makeMockPi(true);
  turnStatsExt(pi as never, { tickMs: 5 });

  await fire(pi, "agent_start", {});
  await sleep(30);
  const shown = pi.widgetCalls.filter((c) => c.value !== undefined);
  check("widget: set above editor while turn runs (key turn-stats)",
    shown.length >= 1 && shown.every((c) => c.key === "turn-stats"),
    JSON.stringify(pi.widgetCalls));
  const firstLine = Array.isArray(shown[0]?.value) ? String((shown[0].value as string[])[0]) : String(shown[0]?.value);
  check("widget: line has elapsed/in/out/tok-s",
    /⏱ .+ in · .+ out · .+ tok\/s/.test(firstLine), firstLine);

  await fire(pi, "message_end", { message: assistantMsg({ input: 4000, output: 80, cost: { total: 0 } }) });
  await sleep(30);
  const lineAfterMsg = [...pi.widgetCalls].reverse().find((c) => c.value !== undefined);
  const lineAfterMsgText = Array.isArray(lineAfterMsg?.value) ? String((lineAfterMsg.value as string[])[0]) : String(lineAfterMsg?.value);
  check("widget: live line reflects completed usage",
    lineAfterMsgText.includes("↑ 4,000 in") && lineAfterMsgText.includes("↓ 80 out"), lineAfterMsgText);

  await fire(pi, "message_update", { message: { role: "assistant", usage: { input: 100, output: 30 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } });
  await sleep(30);
  const lineLive = [...pi.widgetCalls].reverse().find((c) => c.value !== undefined);
  const lineLiveText = Array.isArray(lineLive?.value) ? String((lineLive.value as string[])[0]) : String(lineLive?.value);
  check("widget: partial in-flight usage included",
    lineLiveText.includes("↓ 110 out") && lineLiveText.includes("↑ 4,100 in"), lineLiveText);

  const callsBeforeSettle = pi.widgetCalls.length;
  await fire(pi, "agent_settled", { aborted: false });
  check("widget: cleared at settle (setWidget undefined)",
    pi.widgetCalls.slice(callsBeforeSettle).some((c) => c.value === undefined),
    JSON.stringify(pi.widgetCalls.slice(callsBeforeSettle)));
  const entry = pi.entries[0]?.data as TurnStatsData | undefined;
  check("widget: final entry still appended (completed usage only)",
    pi.entries.length === 1 && !!entry && entry.output === 80 && entry.input === 4000, JSON.stringify(entry));

  await sleep(30);
  check("widget: ticker stopped after settle (no further updates)",
    pi.widgetCalls.length === callsBeforeSettle + 1,
    String(pi.widgetCalls.length));

  // a fresh turn shows the widget again
  await fire(pi, "agent_start", {});
  await sleep(30);
  check("widget: re-shown for next turn",
    pi.widgetCalls.filter((c) => c.value !== undefined).length > shown.length,
    String(pi.widgetCalls.length));
  await fire(pi, "agent_settled", { aborted: false }); // no usage -> no entry, widget cleared
  check("widget: cleared again after no-usage turn", pi.widgetCalls.some((c, i) => i > 0 && c.value === undefined));
}

{ // hasUI=false: widget is never touched, nothing leaks
  const pi = makeMockPi(false);
  turnStatsExt(pi as never, { tickMs: 5 });
  await fire(pi, "agent_start", {});
  await fire(pi, "message_end", { message: assistantMsg({ input: 10, output: 3 }) });
  await fire(pi, "agent_settled", { aborted: false });
  await sleep(20);
  check("hasUI=false: widget never touched", pi.widgetCalls.length === 0, JSON.stringify(pi.widgetCalls));
}

// thinking statement (v3)
{
  const pi = makeMockPi(true);
  turnStatsExt(pi as never, { tickMs: 5 });
  const thinkStart = { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} } };
  const thinkEnd = (text: string, usage?: unknown) => ({
    message: { role: "assistant" as const, ...(usage === undefined ? {} : { usage }) },
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: text, partial: {} },
  });

  // normal block: duration + estimated tokens (no usage.reasoning reported yet)
  await fire(pi, "agent_start", {});
  await fire(pi, "message_start", { message: { role: "assistant" } });
  await fire(pi, "message_update", thinkStart);
  await sleep(30);
  check("thinking: nothing appended while thinking runs", pi.entries.length === 0);
  await fire(pi, "message_update", thinkEnd("x".repeat(400)));
  const th = pi.entries[0];
  check("thinking: one statement right after thinking ends", pi.entries.length === 1 && th?.customType === "turn-thinking",
    JSON.stringify(pi.entries));
  const thData = th?.data as { durationMs: number; tokens: number | null; estimated: boolean; truncated: boolean } | undefined;
  check("thinking: statement has duration >= 30ms and estimated tokens 100",
    !!thData && thData.durationMs >= 30 && thData.tokens === 100 && thData.estimated === true && thData.truncated === false,
    JSON.stringify(thData));

  // exact tokens: provider already reported usage.reasoning on the partial
  await fire(pi, "message_update", thinkStart);
  await fire(pi, "message_update", thinkEnd("y".repeat(800), { input: 10, output: 5, reasoning: 777 }));
  const th2 = pi.entries[1]?.data as { tokens: number | null; estimated: boolean } | undefined;
  check("thinking: exact usage.reasoning preferred over estimate",
    pi.entries.length === 2 && th2?.tokens === 777 && th2.estimated === false,
    JSON.stringify(th2));

  // truncated block: thinking_start, then message_end without thinking_end
  await fire(pi, "message_start", { message: { role: "assistant" } });
  await fire(pi, "message_update", thinkStart);
  await fire(pi, "message_end", { message: { role: "assistant" } });
  const th3 = pi.entries[2]?.data as { truncated: boolean; tokens: number | null } | undefined;
  check("thinking: truncated block -> statement with truncated flag, no tokens",
    pi.entries.length === 3 && th3?.truncated === true && th3.tokens === null,
    JSON.stringify(th3));

  // span reset: thinking_start, then a NEW message starts -> late thinking_end is ignored
  await fire(pi, "message_start", { message: { role: "assistant" } });
  await fire(pi, "message_update", thinkStart);
  await fire(pi, "message_start", { message: { role: "assistant" } });
  await fire(pi, "message_update", thinkEnd("z".repeat(400)));
  check("thinking: span reset across message_start (no leak)", pi.entries.length === 3, String(pi.entries.length));

  // stray thinking_end without a start: ignored
  await fire(pi, "message_update", thinkEnd("q".repeat(400)));
  check("thinking: stray thinking_end ignored", pi.entries.length === 3, String(pi.entries.length));

  // non-assistant message_update: ignored
  await fire(pi, "message_update", { message: { role: "toolResult" }, assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} } });
  check("thinking: non-assistant message_update ignored", pi.entries.length === 3, String(pi.entries.length));

  await fire(pi, "agent_settled", { aborted: false });
  check("thinking: turn still settled cleanly (widget cleared, no turn entry without usage)",
    pi.widgetCalls.some((c) => c.value === undefined) && pi.entries.every((e) => e.customType === "turn-thinking"),
    JSON.stringify(pi.entries.map((e) => e.customType)));
}

{ // hasUI=false: no thinking statements
  const pi = makeMockPi(false);
  turnStatsExt(pi as never, { tickMs: 5 });
  await fire(pi, "agent_start", {});
  await fire(pi, "message_start", { message: { role: "assistant" } });
  await fire(pi, "message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} } });
  await fire(pi, "message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "x".repeat(400), partial: {} } });
  await fire(pi, "agent_settled", { aborted: false });
  check("thinking: hasUI=false -> no entries", pi.entries.length === 0, JSON.stringify(pi.entries));
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
