# SPEC.md — Active Technical Specification & State Anchor

**Status: IMPLEMENTED & VERIFIED** (pi 1.5.0, 2026-11-03, incl. the clickable-dot
enhancement). All automated checks green: 29/29 unit, 16/16 load-smoke, 10/10 PTY
end-to-end (incl. SGR mouse click + resumed-session markers), print-mode regression OK.
Remaining open items: none.

## 1. Human Requirement (Original Intent)
> Chats and sessions get very long. I want markers on the **right side of the window,
> vertically centered** — **one marker per user message I sent** — so I can **jump to my
> own messages**, with the marker I'm **currently at in the message flow highlighted**.

### 1a. Enhancement requirement (2026-11-03, planned via PLAN.md)
- Markers must be **visibly rendered clickable dots** at the right edge of the chat
  area, **one per human prompt** — including prompts from **before the extension was
  activated** and in **resumed sessions**.
- Dots sit **left of the scrollbar**, roughly **20px / 2rem** from the right edge and
  roughly **15px** apart, **vertically centered** in the same direction as the
  scrollbar.
- Terminal rendering exposes cell units, not CSS pixels — approximated as **3 columns
  gap** from the scrollbar (dots at `col = width - 1 - 3`) and **1 row per dot**.

Target environment: pi 1.5.0, **fullscreen TUI mode** (default `tuiMode`). In regular
mode the terminal owns scrollback, so the app cannot anchor the visible window; the
rail is fullscreen-only by design.

## 2. Technical Architecture & Data Flow (as implemented)
- **Core Mechanism — document wrapper (NOT a layout-root wrap, NOT an overlay):**
  `installRail()` replaces the transcript `ScrollView`'s child (the document
  `Container`) with a leaf-shaped `RailDocument` that renders the original document and
  composites the rail onto the right edge via the exported `compositeTuiLine()`.
  **Why this level:** `TuiAltScreen.doRender()` → `renderLayoutFrame(root, …)` walks
  the `LAYOUT_NODE` tree and *never calls the root component's `render()`*; the scroll
  branch renders `scrollContentLines = renderCached(ctx, node.component, contentWidth)`
  where `node.component` **is** `transcript.child`. Wrapping that child guarantees the
  wrapper's `render()` runs every frame and its lines are exactly what gets painted at
  the correct `scrollTop`. (Wrapping the layout root instead silently renders nothing —
  the root's `render()` output is never referenced. This was the root cause of the
  first failed implementation.)
  The wrapper is leaf-shaped (plain `Component`, no `LAYOUT_NODE`), matching the
  original document's shape, so sizing, wheel scrolling, scrollbar, text selection and
  mouse dispatch behave 1:1.
- **Re-attach:** a new fullscreen TUI + layout root appears on startup and every mode
  switch, so the extension patches `TuiAltScreen.prototype.start` **once** (idempotent,
  `globalThis` symbol guard `Symbol.for("pi.agent.messageMarkers.startPatch")`) and
  installs via `setImmediate` after `start()`; plus a `session_start`
  `ctx.ui.custom()` capture (factory calls `done()` synchronously → no flash, nothing
  mounted) for the initial TUI which starts before extensions load. Re-install on an
  already-wrapped document is a no-op re-sync. `installRail` early-returns when the
  rail is disabled (`state.enabled === false`) so mode switches never leave an inert
  wrapper behind unnecessarily.
- **User-message detection (fully recursive):** the transcript document is walked
  recursively (depth guard 32). A node is a user message when duck-typed from pi
  1.5.0's `UserMessageComponent` runtime shape: `typeof text === "string" &&
  Array.isArray(markdownTransformers) && !("message" in node)` (assistant components
  carry a `message` field). Nodes with their own `render` are **opaque leaves**
  (measured, never descended); nodes rendering via `Container.prototype.render`
  (`isCompositeContainer`) are **descended**. Recursion is what gives **resumed
  sessions and pre-activation prompts** their markers (their components can sit
  deeper than the top-level chat container). Verified live against pi 1.5.0 dist.
- **Offsets:** start row = cumulative rendered height (`render(width).length`) of
  preceding transcript children; cached, keyed by a structural snapshot
  `(width, docRef, childCounts, chatChildCount, lastChildRef)` so streaming growth of
  the last assistant message doesn't re-walk per frame.
- **Active marker:** `activeIndex = largest i with startRow[i] < scrollTop +
  viewportHeight`; fallback to first message when viewport is above all of them.
- **Jump:** `ctx.ui.onTerminalInput` (runs before the focused component;
  `{ consume: true }`). `alt+up` → previous, `alt+down` → next user message (relative
  to `activeIndex`), executed as `transcript.scrollTo(startRow[i],
  { disableFollow: true })` + `tui.requestRender()`. Consumed only when the rail is
  enabled and a jump actually targets a marker; otherwise passes through.
  **Key encoding:** pi's key parser maps alt+arrows to ESC+letter (`ESC p` / `ESC n`,
  vim-keys style) — the extension uses the same `matchesKey()` pi uses for its own
  keybindings. **Conflict note:** while the rail is on, `alt+up` shadows pi's
  `app.message.dequeue` default binding; documented in README.
- **Marker visuals:** 2-column marks, **3 columns left of the right edge**
  (`col = width - 1 - SCROLLBAR_GAP_COLUMNS`, `SCROLLBAR_GAP_COLUMNS = 3`; the
  scrollbar owns the last column), vertically centered in the transcript viewport
  (`top = max(0, floor((vh - marks.length)/2))`) and mapped into document rows
  (`docRow = scrollTop + top + i`). Inactive `·` (theme `dim`), active `▸` (theme
  `accent`), `…` at windowed ends (never a jump target). Capacity = `max(3,
  viewportHeight - 2)` — one dot per visible row. All geometry lives in the pure
  exported `computeRail(width, startRows, scrollTop, viewportHeight, docHeight)` →
  `RailLayout { marks: RailMark[]; top; col }` and
  `markerIndexForClick(docRow, rail, scrollTop)`.
- **Mouse (click to jump):** `RailDocument.handleMouse` first offers the event to
  `MarkerRail.mouse(event)`. Only the rail band (`|x - col| <= 1`) is claimed: `press`
  → `{handled: true, render: false}` (swallowed so no text selection starts); `click`
  → `markerIndexForClick` (event.y is already a document row — the wrapper's layout
  box is the scroll child's box, translated by `-scrollTop`; do NOT add scrollTop
  again) → `jumpTo(index)` (shared with the keyboard path) → `{handled: true}`.
  `…` rows and out-of-band events return `undefined` / no-op and pass through to the
  wrapped document, then pi's scrollbar/selection/scroll-to-end handling. `ScrollView`
  has no `handleMouse`; pi dispatches layout mouse events deepest-first, so the
  wrapper sees every transcript click. Jumping happens on `click`, never on `press`
  (press-jump would move the document under the cursor and double-jump on release).
  pi SGR mouse bytes: `ESC [ < b ; x ; y M|m` (1-based x/y, M=press, m=release).
- **Data / Control Flow:**
  `[TuiAltScreen.start → setImmediate installRail → transcript.child = RailDocument]`
  `[per-frame: renderLayoutFrame → renderCached(RailDocument) → inner.render + overlay(offsets cache → activeIndex → composite)]`
  `[alt+up/alt+down → onTerminalInput → rail.jump(±1) → jumpTo(i) → ScrollView.scrollTo → requestRender]
  [SGR mouse press/click on rail band → RailDocument.handleMouse → rail.mouse → jumpTo(i)]`
  `[session_start → theme capture + input binding | /markers on|off|status]`
- **Acceptance Criteria (all verified via PTY e2e unless noted):**
  1. ✅ Right-aligned, vertically centered marker column; one marker per user message.
  2. ✅ Active highlight (▸) on the current user message; updates as the viewport
     moves (offsets/active recomputed per frame from live `scrollTop`).
  3. ✅ `alt+up`/`alt+down` jump between user messages; plain keys pass through.
  4. ✅ New user messages appear as new markers live (offsets cache key changes on
     structural change; verified [18]→[18,45] across a session).
  5. ✅ No overlay used → mode switching never blocked; rail auto re-attaches on
     fullscreen start (patch path). Regular mode: overlay guard returns unmodified
     lines (activeTui stopped) → no rail, no scrollback pollution.
  6. ✅ `/markers status|off|on` (off restores the original document object; on
     re-wraps — both verified in debug trace).
  7. ✅ Zero new runtime dependencies; value imports only from
     `@earendil-works/pi-tui`.
  8. ✅ Exception-safe: try/catch on every install path; print-mode regression
     (`pi -p`) clean.

### Acceptance Criteria — clickable-dot enhancement (all verified via PTY e2e)
  1. ✅ Dots at **column 96** in a 100-col terminal (`width - 1 - 3`), left of the
     scrollbar (col 99); the only `▸ ` in the UI is the active rail mark at col 96.
  2. ✅ **1 row per dot**; marker block **vertically centered** in the viewport.
  3. ✅ **Left-click a dot** (SGR `ESC[<0;x;yM`/`...m`) jumps to that user message;
     keyboard `alt+up` still jumps to the previous one.
  4. ✅ **Backward compatible:** a resumed 4-message session shows **4 markers
     (3 dots + 1 active)** before any new input (fixture session built by the e2e
     driver itself).
  5. ✅ Clicks outside the band, `…` rows, and disabled rail pass through untouched
     (load-smoke mouse pass-through tests).

## 3. Surgical File Map (Strict Scope Boundary)
- `~/.pi/agent/extensions/message-markers.ts` (NEW, single self-contained file,
  auto-discovered):
  - Named exports (pure, unit-tested): `isUserMessageLike`,
    `collectUserMessageOffsets`, `pickActiveIndex`, `windowIndices`, `railCapacity`,
    `railMarkerColumn`, `computeRail`, `markerIndexForClick`, `SCROLLBAR_GAP_COLUMNS`.
  - Named types: `RailMark { index: number | null; active: boolean }`,
    `RailLayout { marks: RailMark[]; top: number; col: number }`.
  - Named exports (structure, load-smoke-tested): `MarkerRail` (incl. `jumpTo` /
    `mouse`), `RailDocument` (incl. `handleMouse`), `installRail`, `RailState`
    (incl. `docHeight`).
  - `export default function (pi: ExtensionAPI)`: idempotent
    `TuiAltScreen.prototype.start` patch; `session_start` (theme capture, custom TUI
    capture, `onTerminalInput` jump keys); `pi.registerCommand("markers", …)`.
- `~/.pi/agent/projects/message-markers/message-markers.ts` (NEW — canonical copy,
  kept in sync with the live file).
- `~/.pi/agent/projects/message-markers/tests/message-markers.test.ts` (NEW — 29 plain
  Node assert unit tests; `node` directly; no framework).
- `~/.pi/agent/projects/message-markers/tests/message-markers.load-smoke.ts` (NEW — 16
  tests: registration, idempotent patch, session_start wiring, key passthrough,
  /markers commands, rpc-mode error, disabled-install guard, mouse pass-through).
- `~/.pi/agent/projects/message-markers/tests/message-markers.pty-e2e.py` (NEW —
  self-contained: spawns a fixture `pi` session (4 messages), a fresh session
  (rail at col 96, centered, `alt+up` jump, **SGR mouse click on a dot** jumps,
  clean `/quit`), and a **resumed** session (4 markers for pre-activation messages).
  Verifies via a minimal built-in terminal emulator (grid + cursor + CSI parsing);
  `MM_DEBUG=1` prints reconstructed screens).
- `~/.pi/agent/projects/message-markers/README.md` (NEW — usage, keys, design, limits,
  debug, tests).

No pi dist files modified. No existing extensions touched.

## 4. Atomic Execution Checklist
- [x] **Step 1 (TDD red→green):** unit tests written; confirmed red
  (`ERR_MODULE_NOT_FOUND`), then green after implementation.
- [x] **Step 2:** pure exports implemented; 19/19 pass.
- [x] **Step 3:** install machinery + patch + session_start + jump keys + `/markers`;
  load smoke 8/8 pass; print-mode `pi -p` regression OK.
- [x] **Step 4:** canonical copy + README; regression re-run green.
- [x] **Step 5 (real TUI verification, automated over PTY):** startup → markers
  rendered (▸/· at right edge); live offsets across 4 user messages;
  `alt+up`/`alt+down` jumps (verified by message-line rewrite at viewport top);
  `/markers status|off|on` (off removes glyphs from next frame, on re-wraps — debug
  trace `uninstallRail: document restored` / `installRail: WRAPPED document`);
  clean `/quit` exit (70 ms).

### Phase 2 — clickable dots, 3-column gap, backward compat (PLAN.md, 2026-11-03)
- [x] **P2 Step 1 (TDD red):** tests for `computeRail`, `railMarkerColumn`,
  `markerIndexForClick`, recursive `collectUserMessageOffsets`, new
  `railCapacity`; red confirmed (`computeRail` not exported).
- [x] **P2 Step 2 (pure logic):** recursive walker + `isCompositeContainer`,
  `railCapacity = max(3, vh - 2)`, `SCROLLBAR_GAP_COLUMNS = 3`, `computeRail`,
  `markerIndexForClick`, `RailState.docHeight`; 29/29 unit.
- [x] **P2 Step 3 (mouse):** `MarkerRail.jumpTo` (shared by keys + click),
  `MarkerRail.mouse` (band-only claim, jump on click), `RailDocument.handleMouse`
  (rail first, try/catch, fall through); 16/16 smoke incl. mouse pass-through.
- [x] **P2 Step 4 (PTY e2e):** self-contained 3-session driver (fixture / fresh /
  resume); col 96 verified by independent `▸ ` search; SGR click verified (debug log:
  `mouse: click → jumpTo 1`); resumed 4-message session shows 4 markers; 10/10 checks.
- [x] **P2 Step 5 (regression + docs):** unit 29/29, smoke 16/16, e2e 10/10 (twice),
  print-mode `pi -p` → `OK`; project copy re-synced (byte-identical); README + SPEC
  updated.

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT wrap `TuiAltScreen.layoutRoot` (the first attempt — `RailRoot`):**
  `renderLayoutFrame` walks the `LAYOUT_NODE` tree and never calls the root
  component's `render()`; a root-level composite is never referenced → invisible
  markers while `overlay()` logs showed the wrapper ran. The scroll view's *child*
  (document) is the correct composite point: it is rendered as a leaf every frame via
  `renderCached` and painted by `paintBox` with `scrollTop` applied.
- **Do NOT use a persistent `ctx.ui.custom({overlay:true})` or `tui.showOverlay()`**
  for the rail: `hasOverlayEntries` makes `InteractiveMode.switchTuiMode()` return
  `false` → mode switching silently blocked.
- **Do NOT use OSC 133 `133;A` scanning** to find user messages — tool-call-free
  assistant messages embed them too.
- **Do NOT rely on widget/header/footer factories for a live TUI reference** — the
  factory captures the TUI of that moment; after a mode switch it is stopped.
- **PTY testing gotchas (cost hours):**
  - Enter must be sent as **`\r`**, not `\n` — pi's terminal input parser treats `\n`
    as inert; with `\n` the message sits in the pending area and is never submitted.
  - pi encodes alt+arrows as **ESC+letter** (`\x1bp`/`\x1bn`), not xterm's
    `\x1b\x1b[B`/`\x1b\x1b[A`; the latter leaks ESC + plain arrow into the editor
    (history recall), producing false positives/negatives.
  - pi 1.5.0 has **no `/exit`** command — the quit command is **`/quit`** and it exits
    **directly, no y/N confirmation** (a typed `y` becomes a chat message).
  - Diff rendering only writes changed lines: assert glyphs over the *whole phase*,
    not a trailing byte window.
  - `TIOCSWINSZ` must use `struct.pack("HHHH", ROWS, COLS, 0, 0)` via `fcntl.ioctl`.
- **TS-private fields read at runtime (accepted, minimal, guarded):** `layoutRoot` on
  `TuiAltScreen`, `stopped` on TUIs, `child`/`scrollTop`/`viewportHeight` on
  `ScrollView`. Everything else is public API: `compositeTuiLine`, `isViewportTUI`,
  `matchesKey`, `TuiAltScreen`, `ScrollView`, `Container`, `VStack`.
- **Monkey-patch hygiene:** `TuiAltScreen.prototype.start` patched exactly once per
  process (`globalThis` symbol guard) so `/reload` doesn't double-wrap; per-instance
  wrap guarded (`doc instanceof RailDocument` → re-sync, no double wrap).
- **Do NOT cache ANSI-styled strings** across theme changes — offsets cache stores
  line counts only; theme applied per frame.
- **Phase 2 guardrails (cost real debugging time):**
  - **Do NOT jump on mouse `press`** — jumping on press moves the document under the
    cursor; the release/click then lands on a different row and double-jumps. Claim
    the press (`{handled: true, render: false}`), jump on `click`.
  - **Do NOT add `scrollTop` inside `handleMouse`** — pi's layout already translates
    the scroll child's box by `-scrollTop`, so `event.y` is already a document row.
  - **Do NOT place marks in column `width - 1`** (the scrollbar column) — the rail
    column is `width - 1 - 3`; only the ±1 band around it is claimed.
  - **Do NOT treat `…` rows as jump targets** (`markerIndexForClick` → null).
  - **Do NOT treat `Container` as an opaque leaf by `typeof render === "function"`** —
    `Container` inherits `render` from `TuiBase` via the prototype; test
    `render === Container.prototype.render` (`isCompositeContainer`) to decide
    descend-vs-leaf. Getting this wrong finds zero user messages.
  - **PTY e2e: SGR mouse bytes are 1-based** (`ESC[<0;97;4M` clicks 0-based
    (96,3)); `M` = press, `m` = release at the same point = click.
  - **PTY e2e: wait patterns must not match the status bar** — `↑ N in` is present
    from startup; wait for the counter to *increase past the pre-send baseline* and
    use unique per-test message text for screen assertions.
  - **PTY e2e: the rail is a centered mini-map, not anchored to message rows** —
    assert jumps by the *first message line at the viewport top*, not by "the
    message text is on the marker row". The block can shift one row between a screen
    read and the click (re-layout on new content): re-read the dot position and
    retry.
  - **Compacted sessions don't render compacted-away messages** — resume tests must
    use an uncompacted session (or expect fewer markers); the e2e builds its own
    4-message fixture for this reason.
- **Do NOT touch:** pi dist files, other extensions, built-in scrollbar/search/
  `scrollToEndIndicator` behaviors.

## 6. Next Immediate Action
- **Done (both phases).** If revisiting: re-run the three test commands in the
  README; any transcript-tree shape change in a future pi release would first
  surface as `collect: … → offsets: []` with `MESSAGE_MARKERS_DEBUG` set, and the fix
  point is `isUserMessageLike` / `collectUserMessageOffsets` / `isCompositeContainer`
  in `~/.pi/agent/extensions/message-markers.ts`. Click geometry lives in
  `computeRail` / `markerIndexForClick` (pure, unit-tested).
