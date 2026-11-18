# PLAN.md — Active Technical Implementation Plan & State Anchor
> Created: 2026-11-16 21:14 · Baseline: `.pi/baseline/2026-11-16_2114/` · Git: 4b9df06 (repo at `~/.pi/agent`, informational) · Status: active · Last verified: —
> After a compaction or in a new session: read this file and `tail -n 60 .pi/LOG.md` before doing anything else.

## 1. Human Requirement (Original Intent)
> User types prompts in pi's TUI input field. They want a lightweight English spelling checker: while typing, English words spelled wrong are underlined in red, directly inside the input field. A `/spelling` slash command toggles the feature on and off. No corrections or suggestions — just the red underline. It must not break anything else, especially the existing `session-name-border` extension which also customizes the editor.

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** A directory-based extension replaces the main editor via `ctx.ui.setEditorComponent()` with a `SpellingEditor` that *delegates* to the currently configured editor (previous factory captured from `ctx.ui.getEditorComponent()` at toggle time; a fresh `CustomEditor` when none). Its `render(width)` override calls the inner editor's `render(width)` (real text/cursor/borders), then post-processes each output line: an SGR-aware parser finds English word tokens in the visible text, checks them against a bundled ~104k-word dictionary (Set, loaded once) with false-positive heuristics, and re-emits the line with misspelled words wrapped in `\x1b[31;4m` (red fg + underline) plus a restore sequence. `/spelling` toggles install/remove of the wrapper factory and notifies the state.
- **Data / Control Flow:** `/spelling` → command handler (tui-guard) → `setEditorComponent(wrapperFactory | previousFactory)` → per TUI render: `SpellingEditor.render(width)` → `inner.render(width)` → `styleLine()` per line (SGR parse → word tokens → `checkWord()` vs cached dictionary) → restyled lines returned
- **Reuse & Conventions:** `CustomEditor` subclass + `render` override pattern from `examples/extensions/modal-editor.ts`; editor-composition pattern per `docs/extensions.md` §`setEditorComponent` ("capture previous factory, wrap"); verification per `pi-extension-upgrade-check` skill (loadtest + pinned `typescript@5.9.2`); dictionary data = free `wamerican` list at `/usr/share/dict/american-english`
- **Acceptance Criteria:**
  1. `/spelling` toggles the checker; `ctx.ui.notify` reports the new state; toggling OFF restores the previously configured editor factory exactly (session-name border returns).
  2. While ON, a misspelled English word (e.g. `recieve`) typed in the input field appears with red underline in the TUI; correctly spelled words render unchanged.
  3. Input behavior is identical to before: editing, cursor movement, paste, history, app shortcuts (clear, model switch), Escape/Ctrl-D, autocomplete all still work (delegation to the inner editor).
  4. `node --test` unit tests (spell + highlight) pass; `pi-ext-loadtest.mjs` prints `ALL LOADED`; pinned `tsc` reports 0 errors for the extension.
  5. Performance: dictionary parsed once at load; per-render work is O(visible chars) with a cache cleared only when text or width changes.

## 3. Surgical File Map (Strict Scope Boundary)
All NEW files; no existing file is modified.
- `/home/julian/.pi/agent/projects/language-checker/test/spell.test.ts` (Symbol: test suite `checkWord`, TDD red first): dictionary lookup + heuristics contract — skip words <3 chars, all-caps, digits, camelCase; handle apostrophes; plural `-s` fallback; built-in tech-term ignore list.
- `/home/julian/.pi/agent/projects/language-checker/test/highlight.test.ts` (Symbol: test suite `styleLine`, TDD red first): restyle of a plain line; SGR preservation + fg restore after styled word; `CURSOR_MARKER` (`\x1b_pi:c\x07`) passes through atomically and words covering the marker position are skipped; no-op when nothing is misspelled.
- `/home/julian/.pi/agent/projects/language-checker/test/tsconfig.json` (Symbol: `compilerOptions`): pinned-tsc typecheck config (`baseUrl` = agent dir, `paths` → release 1.5.2 `index.d.ts` of both packages, include = extension dir + this project dir).
- `/home/julian/.pi/agent/extensions/language-checker/spell.ts` (Symbol: `loadDictionary`, `checkWord`, `IGNORE_WORDS`): pure module, no imports; `loadDictionary(path): Set<string>` lowercased; `checkWord(word, dict): boolean` false = misspelled, with the heuristic skips.
- `/home/julian/.pi/agent/extensions/language-checker/en-words.txt` (Symbol: —): data file, `cp /usr/share/dict/american-english` (~104334 lines, 985KB).
- `/home/julian/.pi/agent/extensions/language-checker/highlight.ts` (Symbol: `styleLine`): pure module; imports `CURSOR_MARKER` from `@earendil-works/pi-tui` only; SGR state machine over one line, word-token regex on visible text, inserts `\x1b[31;4m` / `\x1b[24m`+captured-fg restore.
- `/home/julian/.pi/agent/extensions/language-checker/editor.ts` (Symbol: `class SpellingEditor`): `extends CustomEditor`; owns `inner: Editor` built from the previous factory; shares `inner.actionHandlers` Map (duck-type copy target); guarded accessor proxies for `onSubmit`, `onChange`, `onEscape`, `onCtrlD`, `onPasteImage`, `onExtensionShortcut` (pi assigns these AFTER factory returns — `interactive-mode.js` `setCustomEditorComponent`); `render()` = inner render + `styleLine` per line with text/width cache; delegates `setText`, `getText`, `getExpandedText`, `invalidate`, `handleInput`, `handleMouse`, `setPaddingX`, `getPaddingX`, `setAutocompleteMaxVisible`, `setAutocompleteProvider`, `onAction`, `setWorkingStatusIndicator`; syncs `focused`/`borderColor` in `render()`.
- `/home/julian/.pi/agent/extensions/language-checker/index.ts` (Symbol: default export factory): `pi.registerCommand("spelling", { description, handler })`; module state `{ enabled, previousFactory }`; ON → capture `ctx.ui.getEditorComponent()` (skip re-capture if already wrapped by us) and `setEditorComponent((tui,theme,kb) => new SpellingEditor(tui, theme, kb, previousFactory))`; OFF → `setEditorComponent(previousFactory)`; `ctx.mode !== "tui"` guard with `notify` error; state is in-memory (default OFF).

## 4. Atomic Execution Checklist
> Bookkeeping: the baseline snapshot is the single source of truth; these boxes mirror it for humans. Tick a box only when `diff -u` against the snapshot shows the step's change (or the planned new file exists) AND its verification command passed. Then move `(CURRENT)` to the next open step, update section 6 and `Last verified:`, and append a log entry. Every failed attempt goes into `.pi/LOG.md`; lessons for the future also go into section 5.
- [ ] **Step 1 (CURRENT):** Write `test/spell.test.ts` defining the `checkWord` contract (TDD red) → verify: `node --test /home/julian/.pi/agent/projects/language-checker/test/spell.test.ts 2>&1 | tail -n 5` fails with module-not-found (expected red).
- [ ] **Step 2:** Implement `extensions/language-checker/spell.ts` → verify: same command now passes (exit 0).
- [ ] **Step 3:** Write `test/highlight.test.ts` defining the `styleLine` contract (TDD red) → verify: `node --test .../test/highlight.test.ts 2>&1 | tail -n 5` fails (expected red).
- [ ] **Step 4:** Implement `extensions/language-checker/highlight.ts` → verify: same command now passes (exit 0).
- [ ] **Step 5:** Create `extensions/language-checker/en-words.txt` (`cp /usr/share/dict/american-english`) → verify: `wc -l` ≈ 104334 AND `node -e` loads it via `loadDictionary` and asserts `checkWord("recieve")===false`, `checkWord("receive")===true`.
- [ ] **Step 6:** Implement `extensions/language-checker/editor.ts` + `test/tsconfig.json` → verify: `npx -y -p typescript@5.9.2 tsc -p /home/julian/.pi/agent/projects/language-checker/test/tsconfig.json 2>&1 | tail -n 30` → 0 errors.
- [ ] **Step 7:** Implement `extensions/language-checker/index.ts` → verify: `node /home/julian/.pi/agent/bin/pi-ext-loadtest.mjs 2>&1 | tail -n 5` → `ALL LOADED` exit 0 AND typecheck still 0 errors.
- [ ] **Step 8:** Full regression + handoff → verify: `node --test .../test/` all green + loadtest `ALL LOADED` + typecheck 0 errors; then hand user the manual E2E script (inside pi: `/spelling` → type `recieve` → expect red underline → fix it → expect underline gone → `/spelling` → expect border editor restored).

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** any existing extension in `/home/julian/.pi/agent/extensions/` (especially `session-name-border.ts`), the release directory `/home/julian/.pi/agent/install/releases/`, `/home/julian/.pi/agent/bin/`, pi-tui/pi-coding-agent internals, or anything under `~/.pi/agent/` outside the two paths in section 3.
- **Known Pitfalls / Failed Approaches:**
  - Extension load order is alphabetical by directory entry: our `session_start` handler (if we had one) would run BEFORE `session-name-border.ts` and get clobbered by its `setEditorComponent`. Therefore install ONLY on the `/spelling` command (always after `session_start`) and wrap the captured previous factory.
  - `interactive-mode.js` `setCustomEditorComponent` assigns `onSubmit`/`onChange` (and, via duck typing, `onEscape`/`onCtrlD`/`onPasteImage`/`onExtensionShortcut`) to the OUTER instance after the factory returns — without accessor proxies the inner editor would never receive them and Enter/Escape/shortcuts die.
  - pi copies app action handlers by `customEditor.actionHandlers.set(...)` into the editor's own Map — share the inner's Map instance (`this.actionHandlers = this.inner.actionHandlers`) so both duck-type and resolution work.
  - ES2022 class-field semantics: the base `Editor`/`CustomEditor` constructor may initialize fields before `inner` exists — every accessor setter must null-guard `this.inner`.
  - `CURSOR_MARKER = "\x1b_pi:c\x07"` must pass through `styleLine` untouched; the TUI drops the character directly after it (hardware cursor) — skip restyling any word whose range covers the marker position.
  - Per-line word scan: words split across a word-wrap line break are not checked (accepted limitation, do not "fix" by re-implementing layout).
  - Typecheck MUST pin `typescript@5.9.2` (newer tsc removed `baseUrl` and rejects non-relative `paths`).
  - jiti module boundary: never `instanceof` across `@earendil-works` copies — duck-type like pi does.

## 6. Next Immediate Action
- **Target File & Symbol:** `/home/julian/.pi/agent/projects/language-checker/test/spell.test.ts` (test suite `checkWord`)
- **Next Command:** `write` the failing test file (dictionary lookup, short/all-caps/digit/camelCase skips, apostrophe handling, `-s` plural fallback, ignore list), then run `node --test /home/julian/.pi/agent/projects/language-checker/test/spell.test.ts 2>&1 | tail -n 5` to confirm the expected red.
