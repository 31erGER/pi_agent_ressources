# SPEC.md — Active Technical Specification & State Anchor

## 1. Human Requirement (Original Intent)
> Show the current session's name (the one set with `/name <name>`) on the
> right side of the colored top line of the chat input field. The label text
> is stuck to the left: the beginning of the name is always shown, the name
> text is not bigger than 70 characters, and if it is longer, `...` dots are
> appended at the end of the (truncated) session name.

**v2:** the border label is footer-styled: `~/some/path • session name`
(`~` home-abbreviation, ` • ` separator, same path formatting as the
original footer).

**v3 (current):** the built-in footer is **overridden in the SAME file**
so that deleting this single extension file restores pi's original look and
feel. The footer renders the original built-in footer byte-identical —
except the `• <session name>` suffix on its first (path/branch) line is
gone, because the name is already shown in the top border.

## 2. Technical Architecture & Data Flow
- **Top border (v2, unchanged):** the editor's top border (`lines[0]` of
  `Editor.render()`) is rewritten by a `CustomEditor` subclass
  (`embedWorkingStatus: true`). `appendSessionName()` finds the trailing `─`
  run in the ANSI-stripped line and replaces it with one single
  `borderColor`-colored segment `<filler>─ <label> ─`.
- **Label:** `formatCwd(ctx.sessionManager.getCwd(), HOME)`
  (+ ` • <capName(name)>` when a non-empty name is set; no name → path
  alone; whitespace name → path alone). `formatCwd` replicates the
  built-in footer's `formatCwdForFooter` (home → `~`, outside home → raw).
  Git branch intentionally not in the border label.
- **Truncation (label "stuck to the left"):**
  1. Name part: `visibleWidth > 70` → first 70 visible columns + `...`
     (dots always appended on truncation — see fixed bug in §5).
  2. Full label wider than the border budget (`trailing - 3`): re-truncate
     the whole label from the right with `...` (no dots when budget < 4:
     show as much as fits; budget ≤ 0: plain border).
- **Footer (v3):** `ctx.ui.setFooter(factory)` — the factory wraps pi's
  **real `FooterComponent`** (root-exported) with a session shim:
  - shim getters resolve LIVE at call time from `ctx` (pi resolves
    ExtensionContext values at call time — verified in `runner.js
    createContext()`), so model/thinking-level/context-usage changes are
    picked up without extra event wiring;
  - `sessionManager` is a `Proxy` over `ctx.sessionManager` that masks
    **only** `getSessionName()` → `undefined`; every other method is bound
    and forwarded, so usage stats, cwd, etc. come from the real manager;
  - the wrapper `NamelessFooter` implements pi-tui `Component`
    (`render` + `invalidate`) and `dispose`; `render()` is guarded with
    try/catch → on any error it returns the last good frame instead of
    throwing into the TUI render loop.
  - Consequence: footer line 1 = `~/path (branch)` (no name), lines 2+
    (token stats, context %, model info, extension status lines) are
    byte-identical to the built-in footer — golden-tested.
  - Not in the shim (not exposed to extensions): `routedModel`
    (virtual-model routing indicator) and `modelRuntime` (subscription
    `(sub)` indicator) → both fall back to plain-model display;
    `autoCompactEnabled` stays `true` → `(auto)` shown even if the user
    disabled auto-compact in settings (minor cosmetic edge).
- **Data / Control Flow:**
  ```
  /name <name> → setSessionName → session_info entry + session_info_changed
              → TUI re-render (built-in) → editor.render() [label live]
              (footer re-renders too, but its name getter is masked → no change)

  session_start(tui) → ctx.ui.setEditorComponent(editorFactory)
                      → ctx.ui.setFooter(footerFactory)   [both re-bound per session]
  footerFactory(tui, theme, footerData)
              → new NamelessFooter(new FooterComponent(shim(ctx), footerData))
  git branch change → interactive-mode's own onBranchChange subscription
              → requestRender → footer re-reads getGitBranch() [no wiring needed]
  ```
- **Acceptance Criteria:**
  1. Border: as v2 (all 34 mock checks green).
  2. Footer: byte-identical to the real `FooterComponent` fed the same
     session with the name hidden (golden differential at widths
     200/100/60/30); name changes do not affect the custom footer; the
     real footer does follow renames (proof the masking, not coincidence).
  3. Single-file footprint: deleting
     `~/.pi/agent/extensions/session-name-border.ts` restores BOTH the
     original border and the original footer.
  4. Non-TUI modes unaffected (setEditorComponent + setFooter are no-ops in
     the runner; handler is also guarded by `ctx.mode !== "tui"`).

## 3. Surgical File Map (Strict Scope Boundary)
- `~/.pi/agent/extensions/session-name-border.ts` — **the single extension**:
  - `formatCwd()` — `~` abbreviation (replicated, unexported in pi).
  - `capName()` — 70-column name cap + `...`.
  - `appendSessionName()` — trailing-dash-run splice, left-anchored fitting,
    single colored tail segment.
  - `SessionNameEditor extends CustomEditor` — `render()` override.
  - `createNamelessSession(ctx)` — live session shim + name-masking Proxy.
  - `NamelessFooter` — Component wrapper around the real `FooterComponent`
    (`render` with last-good-frame fallback, `invalidate`, `dispose`).
  - factory: `pi.on("session_start", …)` → setEditorComponent + setFooter.
- `~/.pi/agent/projects/session-name-border/.pi/SPEC.md` — this spec.
- `~/.pi/agent/projects/session-name-border/test/` — `test.mjs` (34 mock
  checks, real CustomEditor + mock theme), `test-real-loader.mjs` (19 checks
  incl. golden footer differential), `tsconfig.json` (strict vs 1.5.0).
- (read-only refs — active pi **1.5.0**)
  - `dist/modes/interactive/components/footer.js` — real `FooterComponent`:
    `getSessionStats()` (entry scan + `getContextUsage()`), `render()`
    (pwd/branch/name line, stats line, extension statuses); uses the
    **module-global** interactive `theme` (needs `initTheme()` outside TUI);
    `invalidate()`/`dispose()` are no-ops (provider owns the git watcher).
  - `dist/core/footer-data-provider.d.ts` — `ReadonlyFooterDataProvider =
    Pick<FooterDataProvider, getGitBranch | getExtensionStatuses |
    getAvailableProviderCount | onBranchChange>` (what `setFooter` passes).
  - `dist/modes/interactive/interactive-mode.js:2041-2058` —
    `setExtensionFooter`: dispose old, clear container, `factory(this.ui,
    theme, this.footerDataProvider)`, addChild; line 817: its own
    `onBranchChange` → requestRender (independent of the footer instance).
  - `dist/core/extensions/runner.js` — `setFooter: () => {}` no-op outside
    TUI; `createContext()` — **all ExtensionContext values are live
    getters** ("resolved at call time").
  - `dist/core/extensions/loader.js` — `loadExtensions(paths, cwd,
    eventBus?, runtime?)` is **async** and NOT root-exported in 1.5.0.
  - `Extension.handlers: Map<string, HandlerFn[]>` (array of functions).

## 4. Atomic Execution Checklist
- [x] **Step 1:** v1 recon (name storage/event, border, editor wiring).
- [x] **Step 2:** v1 extension + verification (all green).
- [x] **Step 3 (v2):** `~/path • name` border label, re-verified all green.
- [x] **Step 4 (v3):** footer override in the same file:
  - recon: `setFooter` API + `ReadonlyFooterDataProvider` surface;
    `FooterComponent` root-exported; ExtensionContext live getters;
    interactive-mode footer wiring (no `invalidate` calls on custom footers).
  - implementation: `createNamelessSession` + `NamelessFooter` wrapper.
  - verification (all green vs live pi 1.5.0):
    - `test.mjs` 34 checks (border: no-name path, short/70/71/100-char,
      widths 3–100, spinner border, `↑ 8 more` scroll border, session
      switch, live `/name`, whitespace name, CJK, non-home cwd).
    - `test-real-loader.mjs` 19 checks: real loader zero errors;
      **golden differential**: custom footer byte-identical to real
      `FooterComponent` with masked name at widths 200/100/60/30; rename
      leaves custom footer unchanged while real footer follows; nameless
      case byte-identical; dispose ok.
    - `tsc --strict` vs 1.5.0 `.d.ts`: clean (required adding
      `invalidate()` to the wrapper — pi-tui `Component` mandates it).
- [ ] **Step 5 (user):** live-TUI smoke test:
  - border: `/name short` → `~/… • short`; 100-char name → 70 + `...`;
    `/name ''` → path alone; narrow terminal; spinner coexistence.
  - footer: first line shows `~/path (branch)` WITHOUT the name; token
    stats / context % / status lines look exactly as before; after
    `/name x` the footer line 1 does not change while the border does.
  - delete the extension file → both border and footer revert to stock.

## 5. Negative Knowledge (Guardrails & Taboos)
- **Single file is a hard requirement** (user: deleting the one file must
  restore original behavior — no companion files).
- **Do NOT** replicate the footer render logic by hand: wrap the real
  `FooterComponent` instead — byte-identical by construction and immune to
  pi footer updates. (Fallback last-good-frame guard covers the case where
  a future pi change breaks the shim.)
- **Do NOT** import deep `dist/` paths from the extension (jiti only
  aliases package roots): `formatCwdForFooter` and `initTheme` stay
  replicated/absent in the extension; the real `FooterComponent` is fine
  because it IS root-exported.
- **Found & fixed (v3):** `capName` dropped the `...` when the 70-column
  slice landed exactly on 70 cols (the `width < 70` condition) — a 100-char
  name rendered 70 chars with NO dots. Now: dots always appended whenever
  `visibleWidth(name) > 70` (the slice is then always a proper prefix).
- **Found (v3, pi 1.5.0 API drift vs 1.4.0):**
  - `loadExtensions` no longer root-exported → deep import
    `dist/core/extensions/loader.js` (tests only); it is now `async`.
  - `ext.handlers.get(event)` values are `HandlerFn[]` (arrays), not single
    functions.
  - pi-tui `Component` **requires** `invalidate()` — missing it fails
    `tsc` and the `setFooter` signature.
  - Rendering `FooterComponent` outside the TUI throws "Theme not
    initialized" until `initTheme()` (deep import
    `dist/modes/interactive/theme/theme.js`) — tests only; in the real TUI
    the theme is already initialized.
- **Known footer-shim limitations (accepted):** no virtual-model routing
  indicator (`routedModel`), no `(sub)` subscription suffix
  (`modelRuntime`), `(auto)` always shown (`autoCompactEnabled` not
  reachable from extensions).
- **Do NOT** touch: bottom border, session files, LLM context,
  `sendMessage`/`appendEntry`, working-status/scroll logic, git-branch
  caching (provider-owned).
- **Do NOT** add an extension-side `session_info_changed` handler: the TUI
  already re-renders on it; all label/footer data is read live.
- **Do NOT** use the official example's `fitBorder` (truncates the wrong
  side for a left-anchored label).
- **Do NOT** construct the editor with `paddingX`/`autocompleteMaxVisible`
  (copied from the default editor by `setCustomEditorComponent`); only
  `embedWorkingStatus: true` must be set explicitly.
- **Known pitfall:** working-status / `↑ N more` border variants are built
  from separate colored segments → splice by visible columns
  (`sliceByColumn`), never string indices.
- **Known pitfall:** the top border's trailing `─` run is the ONLY region
  to splice into; everything before it (spinner, scroll indicator) must
  stay byte-identical.

## 6. Next Immediate Action
- **Target:** code complete and verified (v3). Nothing pending.
- **Next Command:** user live-TUI smoke test (Step 5), then delete-file
  revert check. Re-run harness any time:
  `cd ~/.pi/agent/projects/session-name-border/test && node test.mjs &&
  node test-real-loader.mjs` (tsc: `cd /tmp/snb-test &&
  ./node_modules/.bin/tsc -p ../.../test/tsconfig.json`).
