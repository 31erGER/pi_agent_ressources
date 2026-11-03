# SPEC.md — Active Technical Specification & State Anchor

## 1. Human Requirement (Original Intent)
> Show the current session's name (the one set with `/name <name>`) on the
> right side of the colored top line of the chat input field. The label text
> is stuck to the left: the beginning of the name is always shown, the name
> text is not bigger than 70 characters, and if it is longer, `...` dots are
> appended at the end of the (truncated) session name.

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** the colored top line of the chat input is the editor's
  top border (`Editor.render()` → `renderTopBorder()`, a `─` run colored via
  the editor's dynamic `borderColor` fn — thinking-level / bash-mode color).
  The extension replaces the editor component with a `CustomEditor` subclass
  (`embedWorkingStatus: true`, so the built-in working spinner keeps working)
  whose `render(width)` override rewrites `lines[0]`: it finds the trailing
  run of `─` in the (ANSI-stripped) top border and replaces it with
  `<filler>─<space><label><space>─`, i.e. the label is right-anchored in the
  line but its text is left-anchored (beginning of the name first, truncation
  at the right end only).
- **Name source:** read **live on every render** from
  `ctx.sessionManager.getSessionName()` (latest `session_info` entry;
  `undefined` when unset/cleared). No extension-side state to sync:
  - `/name <name>` → `session.setSessionName()` → `appendSessionInfo()` +
    `session_info_changed` event → the TUI already re-renders on that event
    (`interactive-mode.js:2777`), so the border updates immediately.
  - `/new`, `/resume`, `/fork`, `/reload` → `session_start` → the extension
    re-registers the editor factory with the fresh session's `ctx`, so the
    label follows the session.
  - No name set → top border left exactly as built-in (spinner/scroll
    indicators included).
- **Truncation rules (label "stuck to the left"):**
  1. `visibleWidth(name) <= 70` → show the full name.
  2. else → first 70 visible columns + ASCII `...` (name part ≤ 70 chars,
     dots at the end).
  3. If the terminal is too narrow for ` <label> ` + one trailing dash
     (working spinner / `↑ N more` indicator occupies the left), re-truncate
     the *name* from the right to fit (ellipsis kept when ≥ 4 name columns
     remain); the left part of the name is never the part that gets cut.
  4. No room at all → render the plain border (label dropped).
- **Data / Control Flow:**
  ```
  /name <name> → session.setSessionName → session_info entry + session_info_changed
              → TUI requestRender (built-in) → editor.render(width)
              → super.render(width) (lines[0] = top border)
              → appendSessionName(lines[0], name) → colored label at right edge

  session_start(tui) → ctx.ui.setEditorComponent(factory)
  → InteractiveMode.setCustomEditorComponent → factory(tui, theme, keybindings)
  → new SessionNameEditor (captures ctx via getName closure)
  ```
- **Acceptance Criteria:**
  1. With a name ≤ 70 visible chars: top border shows `…─ <name> ─` (one
     dash gap on each side of the label, right-anchored), same color as the
     line; the rest of the border (spinner while working, `↑ N more` when
     scrolled) is preserved.
  2. With a name > 70 visible chars: exactly the first 70 visible columns are
     shown followed by `...` (never the tail of the name).
  3. With no name: the top border is byte-identical to the built-in one.
  4. `/name` changes the label without any reload; switching sessions
     (`/new`/`/resume`) shows the new session's name; non-TUI modes are
     unaffected.

## 3. Surgical File Map (Strict Scope Boundary)
- `~/.pi/agent/extensions/session-name-border.ts` — **the extension**
  (single file, auto-discovered from the global extensions dir):
  - `capName()` (L ~20–28): 70-column cap + `...`.
  - `appendSessionName()` (L ~30–70): trailing-dash-run detection on the
    ANSI line, left-anchored fitting, recomposition with `borderColor`.
  - `SessionNameEditor extends CustomEditor` (L ~72–90): `render()` override.
  - default factory: `pi.on("session_start", …)` → `ctx.ui.setEditorComponent`.
- `~/.pi/agent/projects/session-name-border/.pi/SPEC.md` — this spec.
- (read-only refs)
  - `dist/core/agent-session.js:3241–3246` — `setSessionName` (event emission).
  - `dist/core/session-manager.js:913–938` — `appendSessionInfo` /
    `getSessionName` (normalization, empty name clears).
  - `dist/modes/interactive/interactive-mode.js:2555–2559, 5536–5557` —
    `/name` handling.
  - `dist/modes/interactive/interactive-mode.js:2206–2266` —
    `setCustomEditorComponent` (factory call, state copy-over);
    `:1777–1780` working indicator → active editor; `:2777–2781` re-render
    on `session_info_changed`; `updateEditorBorderColor` (dynamic
    `borderColor`).
  - `dist/core/extensions/runner.js:153` — `setEditorComponent` no-op in
    non-TUI runtimes.
  - pi-tui `dist/components/editor.js:385–391, 185–197, 428` — top border
    rendering (plain / spinner-embedded via CustomEditor / `↑ N more`
    variants all end in a trailing `─` run); `render()` returns it as
    `lines[0]`.
  - pi-tui exports (verified in `dist/index.d.ts:35`): `visibleWidth`,
    `truncateToWidth`, `sliceByColumn`, `stripTerminalSequences`.
  - `examples/extensions/border-status-editor.ts` — official pattern for
    extending `CustomEditor` + rewriting border lines (reference, not
    copied: its `fitBorder` truncates the right label from the right first,
    which would violate the "stuck to the left" rule).

## 4. Atomic Execution Checklist
- [x] **Step 1:** Recon: verify name storage/event (`session_info`,
  `session_info_changed`), TUI re-render on that event, editor top-border
  structure, `setCustomEditorComponent` wiring, pi-tui string utils — done
  (all line refs above verified against pi 1.4.0 dist).
- [x] **Step 2:** Write `~/.pi/agent/extensions/session-name-border.ts`.
  Verify: jiti load + mock-TUI render assertions. **DONE — all green:**
  - `test/test.mjs` (27 checks, jiti with pi's `getAliases()` mapping,
    mock TUI/theme/ctx): plain/short/70/71/100-char names, terminal widths
    3/6/10/60/80/90, working-spinner border, `↑ N more` scroll border,
    session switch, live `/name` update, whitespace name, CJK width.
  - `test/test-real-loader.mjs` (pi's real `loadExtensions()` from
    `dist/core/extensions/loader.js`): zero load errors, handler fires,
    editor renders `24×─ + " x…x(70)… " + ─` at width 100.
  - `npx tsc --strict -p test/tsconfig.json` (paths → pi 1.4.0 `.d.ts`):
    clean, no type errors.
  - Found & fixed during testing: whitespace-only name rendered a 2-space
    gap (real `getSessionName()` returns `undefined` for it, but the
    extension now also guards `visibleWidth(label) === 0`).
- [ ] **Step 3:** (user) Real-TUI smoke test: `/name short`, `/name` + a
  100-char name, `/name ''` (clears), long multi-line prompt (scroll
  indicator), watch while agent works (spinner + name coexist).
  Re-run harness: `cd ~/.pi/agent/projects/session-name-border/test &&
  node test.mjs && node test-real-loader.mjs`.

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** the bottom border, the footer, the default editor,
  working-status/scroll-indicator logic, session files, or anything in the
  LLM context (pure display; no `sendMessage`/`appendEntry`).
- **Do NOT** register a `session_info_changed` handler for rendering: the
  TUI already re-renders on it (`interactive-mode.js:2777`); the label is
  read live in `render()`, so a handler would be redundant.
- **Do NOT** pass the official example's `fitBorder` approach: it truncates
  the right-aligned label from the right first under space pressure, which
  cuts the *beginning* of the name — violates "stuck to the left".
- **Do NOT** construct the editor with `paddingX`/`autocompleteMaxVisible`
  options — `setCustomEditorComponent` copies both from the default editor
  after construction; only `embedWorkingStatus: true` must be set (it is
  not copied).
- **Known pitfall:** the working-status and `↑ N more` border variants are
  built with *separate* `borderColor` segments (spinner text can be colored
  differently); always splice by visible columns (`sliceByColumn`), never by
  string index.
- **Known pitfall:** `getSessionName()` returns `undefined` for an empty
  (whitespace-only) name — treat as "no name", matching `/name` semantics.

## 6. Next Immediate Action
- **Target File & Lines:** `~/.pi/agent/extensions/session-name-border.ts`
  (whole file — not yet written).
- **Next Command:** write the extension file, then run the jiti-based
  render-assertion test harness (mock TUI `{ terminal: { rows: 40 } }`,
  mock theme `borderColor`, mock `ctx.sessionManager.getSessionName`).
