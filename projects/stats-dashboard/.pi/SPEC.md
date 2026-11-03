# SPEC.md — Active Technical Specification & State Anchor

## 1. Human Requirement (Original Intent)

**v1 (done):** `/stats` slash command → escapeable dashboard overlay (not chat flow) with
tokens, context window + what is in it, loaded context files / skills / extensions; usable
mid-inference without interrupting the run.

**v1.1 (done):**
1. **Global usage counters** — every loaded extension and skill listed with a **global
   counter** (across ALL sessions) of how often it was used / executed, plus a **date it was
   introduced**, so the user can manage (prune) them.
2. **Performance section** — average **tokens per second**: whole session, last 10 turns,
   last 100 turns.

Both features follow the extension-creator → vibe-to-spec workflow and TDD (failing test
first, per my addendum).

**v1.2 (done):** fix the live dashboard popup — (a) bottom border was missing (overlay
`maxHeight` sliced the box; root cause: overlay bounds are stale/undefined during
`render()`, see §5), and (b) the panel could not be scrolled to the bottom (scroll
position was reset to 0 on every render frame); add **mousewheel scrolling**
(`handleMouse` for alt/fullscreen mode + raw SGR passthrough in `handleInput` for
regular mode).

**v1.3 (now):**
1. **Tools in the stats panel** — treated exactly like skills/extensions:
   - *loaded tools* listed (right column), parsed from the `<tools>` section of the
     FINAL system prompt (`- name: description` lines); dynamic/MCP tools included
     (the section reflects `toolsAdded`).
   - *global tool-use counters* — every `tool_execution_start` bumps
     `UsageData.tools[<toolName>]` (persisted like skills/extensions);
     introduced date = birthtime of `dist/core/tools/<name>.js` for the built-in set
     (bash, edit, find, grep, ls, powershell, read, write), else the pi package
     date (i.e. "introduced with this pi version").
2. **Two-column layout** — split all sections into two meaningful groups and divide
   the panel vertically:
   - **LEFT = session** (live state): model/session/cwd/status, context window +
     system-prompt-vs-messages split, system prompt sections, messages by role,
     tokens (session) + last turn, performance.
   - **RIGHT = environment** (loaded + global): loaded resources (context files,
     skills, prompts, extensions), tools, usage (global) for skills/extensions/tools.
   - Box border gets a middle divider (`┬`/`┴`); full-width `stats` title row left,
     `environment` right; footer hint stays full-width. NO information deleted.
   - Overlay width 80% → 92% for comfortable columns; height/scroll logic unchanged
     (box still exactly `floor(rows·0.88)` lines, bottom border always drawn).

## 2. Technical Architecture & Data Flow (v1.1)

- **Core Mechanism (usage):** `stats.ts` gains a `UsageStore` (JSON file at
  `getAgentDir()/usage-stats.json` — global across sessions, never a session entry).
  Counters are incremented by two always-on listeners registered at extension **load time**
  (not only while the dashboard is open):
  - `input` event: text starting `/skill:<name>` → skill use (raw text is visible BEFORE
    skill expansion; extension commands are NOT visible here — they short-circuit earlier,
    so those self-report, see below).
  - `tool_execution_start`: `read` tool with `path` ending in `SKILL.md` → implicit skill
    use (agent consulting the skill).
  Other extensions self-report via exported helpers from `stats.ts` (shared jiti module
  instance = shared store): one line `trackExtensionRun(import.meta.url)` in their
  command handler / main event handler. Read-modify-write per event (file is tiny; safe
  across processes); corrupt file → start fresh, never crash.
- **Usage semantics (documented in README):**
  - skill use = `/skill:name` invocations + `read` of its SKILL.md (both counted)
  - extension run = invocation of a command it registered (self-reported); for
    event-driven extensions: their main event action (self-reported)
  - introduced date = file `birthtime` (fallback `mtime`); shown as YYYY-MM-DD
- **Core Mechanism (performance):** pure `perfStats(items)` over "work items"
  (timestamped generated-token amounts). Work items come from session entries: assistant
  messages + compaction + branch_summary entries that carry `usage` (ISO `timestamp` from
  `SessionEntryBase`). Generated tokens = `usage.output` (already INCLUDES reasoning
  tokens — do not add `reasoning`). tps = Σoutput / span seconds; null (render `—`) when
  <2 items or span ≤ 0. Windows: all items, last 10, last 100 (by entry order).
- **Data / Control Flow:** same as v1; `collectStats(pi, ctx, opts?)` now also reads the
  usage store + computes perf; `buildStatsLines` renders two new sections:
  `usage (global · all sessions)` and `performance (output tokens/s)`.
- **Acceptance Criteria (v1.1):**
  1. `/stats` dashboard lists every loaded skill and extension with a global use/run
     counter and an introduced date (YYYY-MM-DD).
  2. Counters persist across sessions/processes in one JSON file
     (`~/.pi/agent/usage-stats.json`); a new session sees previous counts.
  3. Running `/stats` increments the stats extension's own counter; running `/lmstudio` /
     `/token-counter` increments theirs; typing `/skill:x` or the agent reading a
     SKILL.md increments the skill's counter.
  4. Dashboard shows tokens/s for session / last 10 / last 100 with generated-token total
     and duration; single-message or zero-span windows render `—`.
  5. All new pure logic + store + factory wiring unit-tested (failing tests first);
     integration test renders the new sections against a real session; `tsc --strict`
     clean; pi's real loader still loads all extensions without errors.

## 3. Surgical File Map (Strict Scope Boundary)

- `~/.pi/agent/extensions/stats.ts` — v1.1: `UsageStore` class + pure helpers
  (`attributeSkillInput`, `skillUseFromRead`, `tokensPerSecond`, `perfStats`,
  `formatDuration`, `formatAddedDate`, `fileIntroducedDate`), exported
  `trackExtensionRun`/`trackSkillUse` self-report helpers, load-time listeners, new
  dashboard sections, `collectStats` extended.
- `~/.pi/agent/extensions/lmstudio.ts`, `token-counter.ts`, `notify-on-settle.ts`,
  `session-name-border.ts`, `reload-resources.ts` — **one-line instrumentation each**
  (import + `trackExtensionRun(import.meta.url)` at command/main-action point).
- `~/.pi/agent/usage-stats.json` — runtime artifact (created on first record).
- `~/.pi/agent/projects/stats-dashboard/test/stats-core.test.ts` — new unit tests.
- `~/.pi/agent/projects/stats-dashboard/test/stats-integration.test.ts` — new section
  render checks against a real session + store round-trip.
- `~/.pi/agent/projects/stats-dashboard/README.md` — v1.1 section.
- v1 files unchanged in spirit (dashboard component gains two sections only).

## 4. Atomic Execution Checklist (v1.1)

- [x] **Step 1:** Recon events/commands/usage shapes + SPEC update (this file).
- [x] **Step 2:** Failing tests for usage store, attribution, perf (verify: red with
      `SyntaxError: does not provide an export named 'UsageStore'`).
- [x] **Step 3:** Implement store + pure helpers + `collectStats` extension (verify: unit
      tests green).
- [x] **Step 4:** Dashboard sections + load-time listeners + self-report exports (verify:
      33/33 unit tests green).
- [x] **Step 5:** Instrument the 5 sibling extensions (verify: real loader loads all six,
      0 errors; jiti client self-report test green).
- [x] **Step 6:** Integration test (real session perf render + store round-trip) +
      `tsc --strict` + real-loader check (verify: 3/3 checks green; real `/stats` handler
      self-reported via import.meta.url under jiti).
- [x] **Step 7:** README v1.1 sections (verify: match rendered output).

## 5. Negative Knowledge (Guardrails & Taboos)

- **Do NOT touch:** pi package sources, session files, other extensions beyond the
  one-line instrumentation listed in Section 3 (and keep that diff minimal + documented).
- **Do NOT** queue or call `pi.sendMessage()`; **do NOT** `waitForIdle`/`abort`;
  **do NOT** persist anything to the session (zero-trace rule stays — the global counter
  lives in a separate file, which is allowed: it is not session data).
- **Do NOT** add `usage` summary entries to perf work items (they are rollups → would
  double-count); perf uses assistant + compaction + branch_summary entries only.
- **Do NOT** add `usage.reasoning` to output — `output` already includes it.
- **Known Pitfalls (new):**
  - Extension commands execute BEFORE the `input` event (`AgentSession.prompt` →
    `_tryExecuteExtensionCommand` first) — they are invisible to global listeners;
    hence the one-line self-report convention.
  - pi's extension loader rejects modules without a function default export (loader.js
    L487) — a standalone helper file in `extensions/` would break startup; the shared
    helpers must be exported from `stats.ts` instead.
  - All `SessionEntryBase` timestamps are ISO **strings** → `Date.parse` for perf.
  - `birthtime` can be 0/undefined on some filesystems → fallback chain
    birthtime → mtime → null (render `?`).
- **Known Pitfalls (v1, carried):** see git/README — chars/4 estimation, post-compaction
  null context, section-tag parsing, ANSI in names, package.json ESM marker, jiti-only
  bare-specifier resolution via `~/.pi/agent/node_modules` symlinks.
- **Known Pitfalls (v1.2 — overlay geometry, IMPORTANT):**
  - `TUI.compositeOverlays()` resets `entry.bounds = undefined` at the start of EVERY
    render pass and calls the component's `render()` INSIDE that pass →
    `overlayHandle.getBounds()` is always undefined/stale during `render()`. Deriving
    the viewport from it makes every frame (a) render full content so `maxHeight` slices
    off the bottom border, and (b) clamp `scrollTop` to 0 every frame (scrolling appears
    broken: panel snaps back to the top). **Never read overlay bounds inside render();
    size the box from `tui.terminal.rows` matching the overlay options exactly**
    (content rows = `floor(rows · 0.88) − 2` for `maxHeight: "88%"`).
  - Wheel events: `TuiAltScreen` parses SGR/X10 wheel in an input listener and
    dispatches `TuiMouseEvent{type:"wheel",wheelDelta}` to `handleMouse()` (always
    consumes; wheel outside overlay bounds falls back to transcript scroll).
    `TuiMainScreen` registers NO input listener and enables NO mouse mode → raw SGR
    wheel strings (`ESC[<64;x;yM` up / `ESC[<65;x;yM` down) pass through to the focused
    component's `handleInput()`. Both paths are implemented; do not enable mouse mode
    out-of-band from the extension (it would leak on crash and fight pi's design).

## 6. Next Immediate Action
- **DONE:** v1.2 implemented and verified — 37 unit tests, 3 integration checks, tsc
  clean, real loader loads all six extensions, real `TuiMainScreen`/`TuiAltScreen`
  harness proves: bottom border visible on first frame, scroll survives re-renders,
  wheel scrolls in both modes (handleMouse + raw SGR passthrough).
- **Target (user):** live TUI check — open `/stats`, confirm the full box border,
  scroll to the bottom (arrows/pgdn/wheel) and see the performance section, close with esc.

## 7. Future (not implemented)
- Per-session context-growth sparkline (needs per-session local state).
- Per-message drill-down; RPC/JSON fallback rendering; image token line.
- Usage trend over time (firstSeen/lastUsed already stored — could render a
  "last used" column once counters accumulate real data).
- New extensions added later need the one-line `trackExtensionRun(import.meta.url)` to
  show non-zero counters (documented in README).
