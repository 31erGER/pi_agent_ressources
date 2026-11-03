# SPEC.md — Active Technical Specification & State Anchor

## 1. Human Requirement (Original Intent)
> After every turn, print a few quick stats into the chat interface: time spent in
> the turn, the input and output tokens spent in the turn, the tokens per second,
> and a timestamp of when the turn finished.

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** A small always-loaded extension tracks each user turn from
  `agent_start` (resetting a per-turn accumulator) through every `message_end`
  with an assistant `usage` object, until `agent_settled` (the true end of the
  turn, after all automatic continuations). At settle it computes duration,
  tokens/s (output tokens ÷ seconds) and appends a `custom` session entry. A
  registered entry renderer draws it as one dim line in the chat transcript.
  Custom entries do NOT participate in LLM context (docs: `pi.appendEntry()` +
  `pi.registerEntryRenderer()`), so the chat stays clean for the model.
- **Data / Control Flow:**
  `agent_start -> turn = startTurn()`
  `message_end(assistant) -> addUsage(turn, message.usage)`
  `agent_settled -> finishTurn() -> pi.appendEntry("turn-stats", data)`
  `renderer("turn-stats") -> Box(Text("⏱ 42.3s · ↑ 12,340 in · ↓ 567 out · 13.4 tok/s · $0.0042 · 14:32:05"))`
- **Acceptance Criteria:**
  1. After a normal turn the chat shows one dim line with: duration, input
     tokens, output tokens, output tokens/s, end timestamp (plus cost when > 0,
     "aborted" marker when the run was interrupted).
  2. A turn spanning several low-level agent runs (retries / continuations)
     yields exactly one stats line with summed usage.
  3. The stats line is never sent to the LLM (custom entry, not a message) and
     nothing is printed for runs without any assistant usage.
  4. Token fields use the same semantics as the built-in footer (raw
     `usage.input` / `usage.output`, cache read shown only in the expanded view).
  5. Pure core (accumulation + formatting) is exported and unit-tested; the
     extension loads through pi's real extension loader without errors.

## 3. Surgical File Map (Strict Scope Boundary)
- `~/.pi/agent/extensions/turn-stats.ts` (NEW: whole file — extension + exported
  pure core: `startTurn`, `addUsage`, `finishTurn`, `tokensPerSec`,
  `formatDuration`, `formatNumber`, `formatCost`, `formatClock`, `formatTurnLine`)
- `~/.pi/agent/projects/turn-stats/test/turn-stats.test.ts` (NEW: unit tests for
  the pure core + a mock-ExtensionAPI integration test for event handling)
- `~/.pi/agent/projects/turn-stats/loader-check.mjs` (NEW: real-loader smoke
  check, mirrors stats-dashboard/v15-loader-check.mjs)
- `~/.pi/agent/projects/turn-stats/package.json` (NEW: name "turn-stats", test /
  typecheck / loader-check scripts — mirrors stats-dashboard)
- `~/.pi/agent/projects/turn-stats/tsconfig.json` (NEW: mirrors stats-dashboard,
  includes `test/**` + `../../../extensions/turn-stats.ts`)

## 4. Atomic Execution Checklist
- [x] **Step 1 (CURRENT):** Write this SPEC + project scaffolding
      (`package.json`, `tsconfig.json`) — verify: files exist, `cat` shows name "turn-stats"
- [x] **Step 2:** Write `test/turn-stats.test.ts` (RED) — verify: `node test/turn-stats.test.ts` fails (extension missing)
- [x] **Step 3:** Implement `~/.pi/agent/extensions/turn-stats.ts` (GREEN) — verify: `node test/turn-stats.test.ts` passes
- [x] **Step 4:** Typecheck + real-loader check — verify: `npm run typecheck` clean, `npm run loader-check` prints turn-stats loaded with 0 errors

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** `stats.ts` (the /stats dashboard stays independent),
  `token-counter.ts`, `notify-on-settle.ts`, any pi core source, `settings.json`
  (global extensions in `~/.pi/agent/extensions/` are auto-loaded).
- **Known Pitfalls / Failed Approaches:**
  - `pi.sendMessage()` participates in LLM context → wrong tool for display-only
    stats (docs point to `appendEntry` + `registerEntryRenderer` instead).
  - `agent_end` is NOT a final-idle signal (retries/compaction/queued work can
    start another low-level run) → use `agent_settled` for "the turn finished".
  - `agent_start` fires per LOW-LEVEL run: must not reset the accumulator when a
    continuation starts (only reset when no turn is currently tracked).
  - `message_end` fires for user/tool-result/custom messages too → guard on
    `message.role === "assistant"`.
  - `formatClock` uses `toLocaleTimeString("en-GB", { hour12: false })`; tests
    pin `process.env.TZ = "UTC"` for deterministic output.

## 6. Next Immediate Action
- **Target File & Lines:** `~/.pi/agent/extensions/turn-stats.ts` (NEW, whole file)
- **Next Command:** implement extension, then run
  `node ~/.pi/agent/projects/turn-stats/test/turn-stats.test.ts`
