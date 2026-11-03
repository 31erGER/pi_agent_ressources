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
  type TurnTracker,
  addUsage,
  finishTurn,
  formatClock,
  formatCost,
  formatDuration,
  formatNumber,
  formatTurnLine,
  startTurn,
  tokensPerSec,
} from "../../../extensions/turn-stats.ts";

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

// ── Part 2: integration with a mock ExtensionAPI ─────────────────────────────

interface MockPi {
  on(event: string, handler: (...args: unknown[]) => unknown): () => void;
  appendEntry(customType: string, data?: unknown): void;
  registerEntryRenderer(customType: string, renderer: (...args: unknown[]) => unknown): void;
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  entries: Array<{ customType: string; data: unknown }>;
  renderer: ((...args: unknown[]) => unknown) | null;
}

function makeMockPi(hasUI: boolean): MockPi & { ctx: { hasUI: boolean } } {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
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
  };
  return Object.assign(pi, { ctx: { hasUI } });
}

async function fire(pi: MockPi, event: string, ...args: unknown[]): Promise<void> {
  const ctx = (pi as MockPi & { ctx: unknown }).ctx;
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

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
