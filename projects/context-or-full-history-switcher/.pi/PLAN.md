# PLAN.md — Active Technical Implementation Plan & State Anchor
> Created: 2026-11-16 21:31 · Baseline: `.pi/baseline/2026-11-16_2131/` (empty — every file in section 3 is new) · Git: 4b9df06 (repo at `~/.pi/agent`, informational only) · Status: active · Last verified: 2026-11-16 21:58
> After a compaction or in a new session: read this file and `tail -n 60 .pi/LOG.md` before doing anything else.
> Supersedes: `.pi/archive/PLAN_2026-11-16_2100.md` (superseded; verified progress 0/6 steps) — Delta: replaced the inline `custom`-entry "hidden history block" (no public hook to re-render the built-in transcript; block would sit off-position and stale entries would accumulate in the session file) with a **modal overlay popup** modeled on the user's own `stats.ts` extension — zero session writes, full conversation in chronological order, `q`/Esc restores the TUI exactly as before.

## 1. Human Requirement (Original Intent)
> The pi TUI shows the compaction-aware context (what LM Studio receives) while the session file keeps the full conversation. The user wants a `/history` command — bare = toggle, plus `/history full` and `/history context` — to **view the full conversation in a popup window, like `/stats` does**. The popup must be strictly read-only: after closing it, the TUI and the session file must look **as if nothing happened**, and pi must keep sending the compacted context to the LLM unchanged.

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** A modal overlay via `ctx.ui.custom(…, { overlay: true, overlayOptions: { width: "92%", maxHeight: "88%", anchor: "center", margin: 1 } })` — the exact pattern the user's `~/.pi/agent/extensions/stats.ts` already uses in production on pi 1.5.2 (documented as "Overlay Mode (Experimental)" in `docs/extensions.md` §Custom UI, proven working in the user's environment). The overlay renders a scrollable line list built from session entries: `full` view = `ctx.sessionManager.getBranch()` (entire active branch, chronological); `context` view = `ctx.sessionManager.buildContextEntries()` (the compaction-aware view LM Studio receives). Closing (`q`/Esc) calls `done()`; the handler's `finally` unsubscribes live-update events. **No `pi.appendEntry`, no `sendMessage` — the session file is byte-identical after a popup round-trip.**
- **Data / Control Flow:** `/history [full|context]` (bare = last-used view, default `full`) → guard `ctx.mode === "tui"` → build flat line list in pure function `buildHistoryLines(entries, view)` (user/assistant text in full; tool calls one line each; tool results collapsed to `→ N lines`; compaction/branch-summary markers; system/usage/custom entries skipped) → `ctx.ui.custom` opens `HistoryViewer` overlay (scroll: up/down, pgup/pgdn, mouse wheel incl. raw SGR passthrough for regular mode; close: `q`/Esc) → while open, throttled refresh on `message_update`/`turn_end`/`session_compact` rebuilds the lines (live, like `/stats`) → `done()` → TUI exactly as before.
- **Reuse & Conventions:** `StatsDashboard` structure from `~/.pi/agent/extensions/stats.ts` (line 1834–2050: `contentHeight()` 88% rule, `scrollBy`/`clampScroll`, SGR wheel regex, `handleInput`/`handleMouse`, `setHandle`, `setData`/invalidate) and its command handler (line 2061–2173: subscription list, throttle, `ctx.ui.custom` overlay options, `finally` unsubscription). `ctx.sessionManager.getBranch()/buildContextEntries()`; `pi.registerCommand` + `getArgumentCompletions`; `ctx.ui.notify` for non-TUI guard. Verification per `pi-extension-upgrade-check` skill (pinned `typescript@5.9.2`, `pi-ext-loadtest.mjs`).
- **Acceptance Criteria:**
  1. `/history` opens a centered 92%×88% overlay listing the **full active branch** in chronological order; up/down/pgup/pgdn and mouse wheel scroll; `q`/Esc closes it and the TUI returns to exactly the previous state.
  2. `/history context` opens the same popup showing the compaction-aware view (identical content to what the transcript shows / LM Studio receives); `/history full` opens the full-branch view; bare `/history` re-opens the last-used view (default `full`).
  3. Session file is **byte-identical** before and after opening/closing the popup (zero writes — verified by checksum).
  4. Works while the agent is running: with the popup open, a new assistant message or a compaction updates the list live (throttled), without blocking the agent.
  5. `node --test test/` passes; `pi-ext-loadtest.mjs` prints `ALL LOADED`; `tsc` (pinned 5.9.2) reports 0 errors.

## 3. Surgical File Map (Strict Scope Boundary)
- `src/history-view.ts` (NEW; Symbols: `buildHistoryLines`, `formatEntry`, `clampScroll`, types `HistoryLine`, `HistoryView`, `PlainEntry`): pure functions over plain structural entry objects (matching session JSONL shapes, **no pi imports** — directly unit-testable via Node 26 type-stripping). `buildHistoryLines(entries, view)` is the single source of truth for both popup views.
- `test/history-view.test.ts` (NEW; Symbol: `node:test` suite "history-view"): TDD-first unit tests (written before `src/history-view.ts` exists).
- `~/.pi/agent/extensions/history-view.ts` (NEW; Symbol: default-export factory + `HistoryViewer` component): `HistoryViewer` (modeled on `StatsDashboard`: `contentHeight()`, `scrollBy`/`clampScroll`, `handleInput` with `q`/Esc close + arrows + pgup/pgdn + SGR wheel, `handleMouse` for fullscreen wheel, `setData`/`invalidate`); `pi.registerCommand("history", …)` with `getArgumentCompletions` for `full`/`context`, TUI-mode guard, live-update subscriptions + throttle, `ctx.ui.custom(…, { overlay: true, overlayOptions: { width: "92%", maxHeight: "88%", anchor: "center", margin: 1 }, onHandle })`; imports pure logic from `../projects/context-or-full-history-switcher/src/history-view.ts` (jiti resolves relative TS).
- `.pi/PROJECT_MAP.md` (UPDATED at plan creation — bookkeeping only)

## 4. Atomic Execution Checklist
> Bookkeeping: the baseline snapshot is the single source of truth; these boxes mirror it for humans. Tick a box only when `diff -u` against the snapshot shows the step's change (or the planned new file exists) AND its verification command passed. Then move `(CURRENT)` to the next open step, update section 6 and `Last verified:`, and append a log entry. Every failed attempt goes into `.pi/LOG.md`; lessons for the future also go into section 5.
- [x] **Step 1:** Write failing tests `test/history-view.test.ts` (16 tests for `buildHistoryLines`, `formatEntry`, `clampScroll`). Verification: `node --test test/ 2>&1 | tail -n 15` → FAIL (module not found) → ✅ fixed by implementing src/.
- [x] **Step 2:** Implement `src/history-view.ts` (16/16 tests pass).
- [x] **Step 3:** Write extension `~/.pi/agent/extensions/history-view.ts` (ALL LOADED).
- [x] **Step 4:** Typecheck via `/tmp/ext-tsconfig-histview.json` (pinned tsc 5.9.2, paths → 1.5.2 release `.d.ts`). Verification: `npx -y -p typescript@5.9.2 tsc -p /tmp/ext-tsconfig-histview.json 2>&1 | tail -n 30` → 0 errors.
- [ ] **Step 5:** Zero-write proof: in a live pi session (requires user), record `sha256sum` of the session `.jsonl`, run `/history` → scroll → close → `/history context` → close, re-hash. Verification: checksums identical; TUI visually identical to before.
- [ ] **Step 6:** Manual end-to-end (requires user): in a compacted session, `/history` (full) shows pre-compaction messages in chronological order; `/history context` matches the visible transcript; with popup open during an agent turn, new messages appear live; `q`/Esc returns to default state.

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** pi release files under `~/.pi/agent/install/`, existing extensions (including `stats.ts` — copy conventions, never import/modify it), session JSONL files directly, `~/.pi/agent/node_modules` symlinks, anything in the git repo outside this project directory + the one new extension file.
- **Known Pitfalls / Failed Approaches:**
  - The earlier inline-`custom`-entry design was dropped on purpose: no public hook re-renders the built-in transcript; the block rendered off-position (at append point, not chronological) and stale entries would accumulate (no entry-deletion API). Do not revive it.
  - Never use `pi.sendMessage`/`sendUserMessage`/`appendEntry` in this extension — any session write would break the "as if nothing happened" guarantee. The extension is 100% in-memory while the popup is open.
  - Overlay `render()` must NOT derive the visible height from overlay `bounds` — `compositeOverlays` resets `entry.bounds` to undefined every pass (documented in `stats.ts` `contentHeight()`; using bounds makes scrolling break). Use `tui.terminal.rows * 0.88 - 2`.
  - Regular (non-fullscreen) mode forwards raw SGR wheel sequences into `handleInput` — handle both parsed mouse events (fullscreen) **and** the SGR passthrough regex, or wheel scrolling breaks in one of the two modes.
  - The `done()` callback must be the only way to close the overlay; never call `OverlayHandle.hide()` on a `ctx.ui.custom` overlay.
  - All live-update subscriptions must be unsubscribed in a `finally` after `ctx.ui.custom` resolves, or handlers leak across sessions.
  - Node 26 type-stripping: `src/` and `test/` must use erasable TS only (no enums, namespaces, parameter properties).
  - Extension imports are limited to the jiti aliases: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (+ node builtins).
  - Pin `typescript@5.9.2` for tsc — newer tsc removed `baseUrl`/non-relative `paths` and breaks the tsconfig template.
  - Overlay mode is documented as "Experimental" — behavior can shift between pi releases; the `pi-extension-upgrade-check` skill covers re-verification after upgrades.

## 6. Next Immediate Action
- **Target File & Symbol:** Session file verification (requires user in live pi session)
- **Next Command:** Step 5 — in a live pi session, record `sha256sum` of the session `.jsonl`, open `/history` popup → scroll → close → `/history context` → close, re-hash. Verification: checksums identical (zero writes).

---
> **Steps 5 & 6 require a live pi session** — I cannot execute them remotely. After you verify these, reply "done" and I'll mark the plan complete.
