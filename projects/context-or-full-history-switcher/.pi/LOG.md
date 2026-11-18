
### 2026-11-17 08:11 · PLAN
- Plan REVISED per user decision: modal popup (like /stats) instead of inline custom-entry block. Rationale: popup = zero session writes (session file byte-identical after close), full conversation in chronological order, q/Esc restores default state; user explicitly wanted "return as if nothing happened".
- Old plan archived as .pi/archive/PLAN_2026-11-16_2100.md (status: superseded, 0/6 steps done); old log archived as LOG_2026-11-16_2100.md.
- New design: /history [full|context] (bare = last-used, default full) → ctx.ui.custom overlay (92% x 88%, center) rendering buildHistoryLines(getBranch() | buildContextEntries()); live refresh like stats.ts; NO session writes.
- No baseline snapshot (all plan files are new).

### 2026-11-18 07:29 · STEP done · Step 2
- Implemented src/history-view.ts: buildHistoryLines(entries, view), formatEntry(entry, view), clampScroll(scrollTop, delta, contentHeight, viewHeight), plus helpers extractText, countTextLines, formatAssistantContent, formatToolResult.
- Verification: node --test test/ → 16/16 pass.
- Baseline snapshot created at .pi/baseline/2026-11-16_2138/ (test/history-view.test.ts + src/history-view.ts).

### 2026-11-18 07:30 · STEP done · Step 4
- Typecheck passed: 0 errors with tsc 5.9.2 (pinned), paths → 1.5.2 release .d.ts.
- Fixed: Component/OverlayHandle/TUI/TuiMouseEvent/TuiMouseEventResult imported from @earendil-works/pi-tui (not pi-coding-agent); handler args is string (not string[]).
- Runtime load test: ALL LOADED (re-verified after type fixes).

### 2026-11-18 07:37 · BUGFIX · Step 3
- Fixed: HistoryViewer popup rendered empty because cachedEntries started as [] and setEntries() was never called before first render.
- Fix: entries passed to constructor, cachedEntries initialized there. Component now renders with data on first paint.
- Typecheck: 0 errors. Load test: ALL LOADED.

### 2026-11-18 07:40 · UI IMPROVEMENT · Step 3
- Redesigned HistoryViewer popup: theme-aware colors (user=accent, toolCall=dim, compaction=warning, toolResult=error/dim), header line with mode label + line count, separator line, footer with key hints.
- Added color hints to buildHistoryLines output (HistoryLine.color field).
- Typecheck: 0 errors. Load test: ALL LOADED. Unit tests: 16/16 pass.

### 2026-11-18 08:08 · STEP done · UI restyle (Step 3 rework)
- TDD: rewrote test suite first (19 tests) → RED (12 fail) → implemented → GREEN (19/19).
- New line format: UTC HH:MM timestamp on every entry's first line; "You:" (accent) / "Assistant:" labels; blank line between entries; toolResult → "↳ ok · N lines" (dim) / "↳ error · N lines" (error, singular "1 line"); compaction/branch_summary warning.
- Fixed box height bug: render emitted viewH+5 lines into a viewH+2 budget (bottom border clipped). contentHeight() is now 88% budget − 7; box is exactly 7 chrome lines (borders + header + 2 dividers + footer).
- Blank separator lines keep the right border: truncateToWidth(…, pad=true).
- Clean ThemeColor-typed ROLE_TOKEN (no inline import() cast); header shows mode + line range (scroll position); bare /history reopens last-used view.
- Verification: node --test test/ → 19/19; tsc 5.9.2 → 0 errors; pi-ext-loadtest → ALL LOADED; visual smoke render OK.

### 2026-11-18 11:35 · STEP done · word wrap in popup
- User report: long messages were single lines truncated with "…" at the box border.
- Fix (component only, pure logic untouched): render() now wraps each logical line with pi-tui wrapTextWithAnsi(line, inner) — same word wrapper pi's own TUI uses (handles ANSI, CJK, emoji, and breaks single overlong tokens char-by-char).
- Wrap cache keyed by (entries ref, view, width): scrolling re-slices only; setEntries() invalidates via invalidate().
- Verification: tsc 5.9.2 → 0 errors; pi-ext-loadtest → ALL LOADED; smoke render with real pi-tui 1.5.2 → wraps at border, blank separators intact, right border aligned.
