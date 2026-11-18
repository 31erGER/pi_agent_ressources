
### 2026-11-16 21:16 · PLAN
- Did: Created .pi/PROJECT_MAP.md, .pi/PLAN.md (8 steps, TDD order) for language-checker extension; no previous plan/log existed.
- Baseline: .pi/baseline/2026-11-16_2114/ (empty — all plan files are NEW, nothing pre-existed to snapshot)
- Feasibility confirmed via recon: setEditorComponent/getEditorComponent + CustomEditor render-override (modal-editor.ts example) + Editor.getText/onChange + registerCommand + CURSOR_MARKER handling.
- Key risk found: session-name-border.ts also calls setEditorComponent on session_start (runs after us alphabetically) → install only on /spelling toggle, wrapping captured previous factory.

### 2026-11-17 08:24 · Step 1 · STEP done
- Did: Wrote test/spell.test.ts (TDD contract for checkWord/loadDictionary/IGNORE_WORDS, hermetic synthetic dict).
- Command: `node --test test/spell.test.ts` → fails with `ERR_MODULE_NOT_FOUND .../extensions/language-checker/spell.ts` (expected RED)
- Note: Node 26 native type-stripping runs .ts test files directly; no runner config needed.

### 2026-11-17 08:56 · Step 2 · STEP done
- Did: Implemented extensions/language-checker/spell.ts (checkWord heuristics, loadDictionary, IGNORE_WORDS ~150 terms).
- Command: `node --test test/spell.test.ts` → pass 9, fail 0 (GREEN)

### 2026-11-17 09:28 · Step 3 · STEP done
- Did: Wrote test/highlight.test.ts (styleLine contract: SGR parse, fg restore, CURSOR_MARKER safety, visible-text invariant).
- Command: `node --test test/highlight.test.ts` → ERR_MODULE_NOT_FOUND .../highlight.ts (expected RED)

### 2026-11-18 08:22 · Step 4 · attempt 1 · FAILED
- Did: First run of highlight tests after initial highlight.ts implementation: invariant test failed — truecolor fg restore emitted `\x1b[38;2;220;50;NaNm`.
- Command: `node --test test/highlight.test.ts` → 1 failing (assertion, actual 'styled recieveaNm bold')
- Result: applySgr got params WITH the final 'm' byte ("47m" → NaN via Number()).
- Conclusion: fixed with seq.slice(2, -1); re-run → pass 13, fail 0 (GREEN). Lesson recorded in PLAN section 5.

### 2026-11-18 08:25 · Step 5 · STEP done
- Did: Copied /usr/share/dict/american-english → extensions/language-checker/en-words.txt (104334 lines, 102173 unique ≥3-char words).
- Command: `wc -l` = 104334; `node -e` loadDictionary+checkWord → recieve flagged=false ✓, receive accepted=true ✓

### 2026-11-18 08:40 · Step 6 · STEP done (after 2 failed typecheck attempts)
- Did: Wrote editor.ts (SpellingEditor delegating wrapper) + test/tsconfig.json.
- Command: `npx -y -p typescript@5.9.2 tsc -p test/tsconfig.json` → attempt 1: 13 errors (TS2611 property→accessor override illegal; Keybindings vs KeybindingsManager; MouseEvent→TuiMouseEvent; handleMouse return type; WorkingStatusIndicator not exported — real type is StatusIndicator); attempt 2: 1 error (single `as` rejected — types don't overlap); attempt 3: exit 0.
- Fixes: callbacks proxied via Object.defineProperty in constructor (no declared accessors); `as unknown as KeybindingsManager` at the one boundary; TuiMouseEvent/TuiMouseEventResult; Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]; added missing setText override after re-reading setCustomEditorComponent impl (it calls newEditor.setText(currentText)).

### 2026-11-18 08:42 · Step 7 · STEP done
- Did: Wrote index.ts (extension entry: /spelling toggle command). First tsc run: 2 errors (`pi.ui` not on ExtensionAPI → APIs live on ctx.ui). Second: 2 errors (extension-level EditorFactory uses KeybindingsManager, 3rd arg). Fix: editor.ts EditorFactory now structurally identical to core's (KeybindingsManager param, EditorComponent return); constructor takes KeybindingsManager directly (no cast); getEditorComponent needs no cast. tsc exit 0.

### 2026-11-18 09:19 · Step 8 · STEP done (regression green, plan closed)
- Did: Discovered the REAL cursor layout (pi-tui tui.js 1.5.2): `CURSOR_MARKER (\x1b_pi:c\x07, focused only) + FAKE_CURSOR_START (\x1b_pi:fc\x07) + grapheme + FAKE_CURSOR_END (\x1b_pi:/fc\x07)` is rendered inside the text line at the cursor cell — a cursor on a letter SPLITS the word, invalidating the old "word covers marker position" rule.
- Rewrote highlight.ts cursor logic: findCursorSpan() locates the span; if the grapheme under the cursor is a letter, word fragments directly touching the span are skipped; on a non-letter grapheme (word boundary) adjacent words are styled normally. Bare marker uses the char after it as the grapheme. Added 4 fake-cursor tests (stubAny strict stub so broken fragment-skip is detected).
- Bugs found & fixed this step: (1) editor.ts render passed checkWord DIRECTLY — checkWord(true)=OK but styleLine expects true=flag → inverted checker (flagged please/the/package, missed recieve); fixed with negation; caught by new smoke test. (2) highlight.ts rewrite dropped the [ ] from the CSI_PARAMS/FINAL regexes (literal-string regexes) → SGR sequences mis-parsed; fixed, exact-match SGR tests guard it. (3) isSeq OSC branch used String.search(pattern, pos) — search takes 1 arg; rewritten as manual scan. (4) smoke-test stubs: onExtensionShortcut must return false for plain typing (CustomEditor.handleInput consumes true-returning input); keybindings stub needs matches:()=>false; tui.terminal.rows must be a number (NaN → empty render).
- Added test/smoke.test.ts: runs pi's exact setCustomEditorComponent wiring sequence (callback assignment, setText, borderColor, padding, actionHandlers copy, working status, focus) against the REAL CustomEditor class; asserts red underline appears, toggling off removes it, typing reaches the inner editor, callbacks mirrored.
- Updated pi-ext-loadtest.mjs: directory-based extension discovery (subdir index.ts / package.json pi.extensions) mirroring the real loader; fixed doubled dir label.
- Gates: `node --test test/` → pass 27, fail 0; loadtest → ALL LOADED exit 0 (language-checker/index.ts OK, default export function); tsc 5.9.2 → 0 errors.
- Added extensions/language-checker/README.md; cleaned .pi/ scratch probes.
- Status: implementation complete — only user manual E2E remains (see PLAN §6).

### 2026-11-18 11:19 · Post-completion change · default ON (opt-out) · done
- Request: user wants the checker ON by default instead of opt-in.
- Design: install on `session_start`, but DEFERRED by one macrotask (`setTimeout(0)`). Verified in pi 1.5.2 `core/extensions/runner.js` that `emit()` awaits session_start handlers in alphabetical extension order — language-checker (l) runs BEFORE session-name-border (s), so a synchronous install would be clobbered; the deferral runs after all handlers and wraps the LAST installed factory. Guards: `userPref === false` respected (explicit opt-out persists across resume/fork within the process; fresh module = default ON again); `current === installedFactory` identity check prevents self-wrapping on repeated session_start.
- TDD: wrote test/index.test.ts (4 tests: default-ON wrapping of a later extension's editor; /spelling OFF restores exact factory + ON re-wraps; explicit OFF persists across simulated session switches; fresh module defaults ON). RED confirmed (4/4 failed: nothing installed on session start), then implemented index.ts (install/uninstall helpers, session_start handler, userPref state) → GREEN.
- Decisions: default enable is SILENT (no startup notification spam — red underlines are the visible feedback); explicit /spelling toggles still notify.
- Gates: `node --test test/` → 31/31; loadtest → ALL LOADED exit 0; tsc 5.9.2 → 0 errors (after fixing a bad return-type annotation on loadExtension: `Promise<(pi) => void>`, not an extra `=> void` wrap).
- Docs: extension README updated (Usage = ON by default; deferred-install rationale in the file table); PLAN §5 guardrail updated from "install only from /spelling" to the deferred-install solution.
