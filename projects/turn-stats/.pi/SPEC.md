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

## 7. v2 — Live stats above the input while the turn runs

### 7.1 Human Requirement (Original Intent)
> While the turn runs, show the same quick stats (elapsed time, in/out tokens,
> tok/s) right above the chat input field, sticky (pinned, not scrolling with
> the chat), close to how Claude Code handles it.

### 7.2 Architecture & Data Flow
- **Core Mechanism:** On a new turn's `agent_start` the extension starts a
  250 ms ticker that pushes the live line to `ctx.ui.setWidget("turn-stats",
  [line])` — the default widget placement is above the editor/input. The line
  is only re-set when it actually changes. Live numbers come from the tracker
  plus the in-flight message's partial `usage` (captured from
  `message_start`/`message_update`; providers differ in what they stream, so
  everything is defensive — worst case the line shows tokens of completed
  messages only). On `agent_settled`/`session_shutdown` the ticker stops, the
  widget is cleared (`setWidget(key, undefined)`), and the final chat line from
  v1 is appended as before.
- **Data / Control Flow:**
  `agent_start(new turn) -> ticker.start + setWidget`
  `message_start/update(assistant) -> liveUsage = message.usage (if present)`
  `ticker(250ms) -> formatLiveLine(liveStats(tracker, now, liveUsage)) -> setWidget (only on change)`
  `message_end(assistant) -> addUsage(tracker, final); liveUsage = null`
  `agent_settled / session_shutdown -> ticker.stop + setWidget(undefined) + (settle: appendEntry)`
- **Acceptance Criteria:**
  1. While a turn runs, a sticky line above the input shows
     `⏱ <elapsed> · ↑ <in> in · ↓ <out> out · <x> tok/s`, updating live.
  2. The widget is removed as soon as the turn settles (or the session
     shuts down); the final stats line in the chat still appears (v1 behavior).
  3. No ticker/widget activity in print/json mode (hasUI=false); no leaked
     intervals after settle/shutdown (pi must be able to exit).
  4. `liveStats`/`formatLiveLine` are exported pure functions, unit-tested;
     integration test asserts the mock `ui.setWidget` is fed live lines and
     cleared at settle.

### 7.3 Checklist (v2)
- [x] **S1:** SPEC updated (this section) — verify: file read
- [x] **S2 (CURRENT):** RED — add live-core + widget integration tests to
      `test/turn-stats.test.ts` — verify: `node test/turn-stats.test.ts` fails
      (missing `liveStats`/`formatLiveLine`, no setWidget calls)
- [x] **S3:** GREEN — extend `turn-stats.ts` (ticker, liveUsage capture, widget
      lifecycle) — verify: `node test/turn-stats.test.ts` passes
- [x] **S4:** typecheck + loader-check — verify: `npm run typecheck`,
      `npm run loader-check` clean

### 7.4 Negative Knowledge (v2)
- **Partial `usage` is provider-dependent** (e.g. Anthropic reports input
  tokens early, output at the end; some providers stream none) → always fall
  back to completed-message totals; never block on usage.
- **Never call `setWidget` per token** (`message_update` is high-frequency);
  rendering happens only on the ticker, and only when the line changed.
- **The ticker must be cleared on `agent_settled` AND `session_shutdown`**,
  otherwise a ref'd interval keeps the pi process alive.
- Widget key is `"turn-stats"` (same namespace as the custom entry type);
  `setWidget(key, undefined)` clears it.

## 8. v3 — Thinking statement right after the thinking block ends

### 8.1 Human Requirement (Original Intent)
> The end-of-turn stats already include thinking (wanted that way, no change
> there). Additionally: a stats statement right after the model's thinking is
> done, showing how long the model thought and how many tokens the thinking
> cost.

### 8.2 Architecture & Data Flow
- **Core Mechanism:** pi's stream events include `thinking_start` /
  `thinking_end` (on `message_update.assistantMessageEvent`). On
  `thinking_start` we record the time; on `thinking_end` we compute the exact
  duration and append a dim chat entry (custom entry `"turn-thinking"`,
  LLM-invisible, same mechanism as the v1 turn line). Thinking tokens:
  `usage.reasoning` is only populated from the provider's FINAL usage chunk
  (verified in pi-ai: Anthropic `message_delta` at message end,
  OpenAI-compatible final chunk) → at `thinking_end` it is normally unknown,
  so the statement uses the exact `usage.reasoning` when the provider already
  reported it, otherwise an estimate via the house chars/4 heuristic on the
  full thinking text (carried by `thinking_end.content`), clearly marked with
  "≈". A thinking block cut off by an abort (no `thinking_end` before
  `message_end`) yields a `"truncated"` statement with duration only.
- **Data / Control Flow:**
  `message_update(assistantMessageEvent.type=="thinking_start") -> thinkingStartedAt = now`
  `message_update(...=="thinking_end") -> thinkingStats(startedAt, now, usage?.reasoning, content) -> pi.appendEntry("turn-thinking", data)`
  `message_end(assistant, span still open) -> truncated statement`
  `message_start(assistant) -> span reset (new model call)`
- **Acceptance Criteria:**
  1. One dim statement per thinking block, appended right after the block
     ends: `🧠 thought 12.4s · ≈1,234 thinking tok` (≈ when estimated, plain
     number when the provider reported it).
  2. Duration is measured thinking_start → thinking_end (exact wall clock);
     tokens are exact `usage.reasoning` when available at that moment, else
     chars/4 estimate of the thinking text, else omitted (truncated block).
  3. Multiple thinking blocks in one message (interleaved thinking) produce
     one statement each; thinking state never leaks across messages/turns;
     nothing is appended in print/json mode (hasUI=false).
  4. `thinkingStats`/`formatThinkingLine`/`estimateThinkingTokens` are pure,
     exported and unit-tested; v1/v2 behavior is unchanged (turn-end line and
     live widget keep working, 52 existing tests stay green).

### 8.3 Checklist (v3)
- [x] **S1:** SPEC updated (this section) — verify: file read
- [x] **S2 (CURRENT):** RED — thinking-core + integration tests in
      `test/turn-stats.test.ts` — verify: `node test/turn-stats.test.ts` fails
      (missing exports / no entries appended on thinking events)
- [x] **S3:** GREEN — extend `turn-stats.ts` (span tracking, thinking_end /
      truncated message_end handling, `turn-thinking` entry renderer)
      — verify: `node test/turn-stats.test.ts` passes
- [x] **S4:** typecheck + loader-check — verify: `npm run typecheck`,
      `npm run loader-check` clean

### 8.4 Negative Knowledge (v3)
- **`usage.reasoning` is NOT available at `thinking_end`** for the major
  providers (populated only from the final usage chunk — verified in pi-ai
  dist: anthropic-messages.js:663, openai-completions.js:1179,
  openai-responses-shared.js:502). Never block on it; estimate with "≈".
- **`thinking_delta` is high-frequency** — only `thinking_start` /
  `thinking_end` are handled; no per-delta work.
- `thinking_end.assistantMessageEvent.content` carries the COMPLETE thinking
  text of the block (pi-ai types) — that is the estimation input.
- One statement per thinking block means noisy turns get several lines —
  that is the requested behavior; do not silently dedupe.
