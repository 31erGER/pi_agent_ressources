# SPEC.md — Active Technical Specification & State Anchor

**Status: IMPLEMENTED & VERIFIED** (pi 1.5.0, 2026-11-03). All automated checks green:
19/19 unit, 8/8 load-smoke, 5/5 PTY end-to-end, print-mode regression OK.
Remaining open items: none blocking (optional manual checks listed in §4 Step 5).

## 1. Human Requirement (Original Intent)
> Chats and sessions get very long. I want markers on the **right side of the window,
> vertically centered** — **one marker per user message I sent** — so I can **jump to my
> own messages**, with the marker I'm **currently at in the message flow highlighted**.

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
- **User-message detection:** transcript tree is
  `layoutRoot.children[0]` (ScrollView, `primary: true`) → `.child` (document
  `Container`) → `[headerContainer, loadedResourcesContainer, chatContainer]`. User
  messages are direct children of the chat container, duck-typed from pi 1.5.0's
  `UserMessageComponent` runtime shape: `typeof text === "string" &&
  Array.isArray(markdownTransformers) && !("message" in node)` (assistant components
  carry a `message` field). Verified live against pi 1.5.0 dist.
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
- **Marker visuals:** 2-column rail at the right edge (`col = width - 2`), vertically
  centered over the visible viewport and mapped into document rows
  (`docRow = scrollTop + top + i`). Inactive `·` (theme `dim`), active `▸` (theme
  `accent`), `…` at windowed ends. Capacity = `clamp(floor(viewportHeight/2), 3, 15)`.
- **Data / Control Flow:**
  `[TuiAltScreen.start → setImmediate installRail → transcript.child = RailDocument]`
  `[per-frame: renderLayoutFrame → renderCached(RailDocument) → inner.render + overlay(offsets cache → activeIndex → composite)]`
  `[alt+up/alt+down → onTerminalInput → rail.jump(±1) → ScrollView.scrollTo → requestRender]`
  `[session_start → theme capture + input binding | /markers on|off|status]`
- **Acceptance Criteria (all verified via PTY e2e unless noted):**
  1. ✅ Right-aligned, vertically centered marker column; one marker per user message.
  2. ✅ Active highlight (▸) on the current user message; updates as the viewport
     moves (offsets/active recomputed per frame from live `scrollTop`).
  3. ✅ `alt+up`/`alt+down` jump between user messages; plain keys pass through.
  4. ✅ New user messages appear as new markers live (offsets cache key changes on
     structural change; verified [18]→[18,31]→[18,31,45,56] across a session).
     Compaction/`/tree`/resume rebuild the same way (same detection path) — not
     explicitly scripted.
  5. ✅ No overlay used → mode switching never blocked; rail auto re-attaches on
     fullscreen start (patch path). Regular mode: overlay guard returns unmodified
     lines (activeTui stopped) → no rail, no scrollback pollution.
  6. ✅ `/markers status|off|on` (off restores the original document object; on
     re-wraps — both verified in debug trace).
  7. ✅ Zero new runtime dependencies; value imports only from
     `@earendil-works/pi-tui`.
  8. ✅ Exception-safe: try/catch on every install path; print-mode regression
     (`pi -p`) clean.

## 3. Surgical File Map (Strict Scope Boundary)
- `~/.pi/agent/extensions/message-markers.ts` (NEW, 569 lines, single self-contained
  file, auto-discovered):
  - Named exports (pure, unit-tested): `isUserMessageLike`,
    `collectUserMessageOffsets`, `pickActiveIndex`, `windowIndices`, `railCapacity`.
  - Named exports (structure, load-smoke-tested): `MarkerRail`, `RailDocument`,
    `installRail`, `RailState`.
  - `export default function (pi: ExtensionAPI)`: idempotent
    `TuiAltScreen.prototype.start` patch; `session_start` (theme capture, custom TUI
    capture, `onTerminalInput` jump keys); `pi.registerCommand("markers", …)`.
- `~/.pi/agent/projects/message-markers/message-markers.ts` (NEW — canonical copy,
  kept in sync with the live file).
- `~/.pi/agent/projects/message-markers/tests/message-markers.test.ts` (NEW — 19 plain
  Node assert unit tests; `node` directly; no framework).
- `~/.pi/agent/projects/message-markers/tests/message-markers.load-smoke.ts` (NEW — 8
  tests: registration, idempotent patch, session_start wiring, key passthrough,
  /markers commands, rpc-mode error, disabled-install guard).
- `~/.pi/agent/projects/message-markers/tests/message-markers.pty-e2e.py` (NEW — spawns
  a real `pi` fullscreen session in a 14×100 PTY; asserts rail glyphs, alt+up/alt+down
  jumps by observing message-line movement, clean `/quit`).
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
  rendered (▸/· at right edge, col 108 of 110); live offsets across 4 user messages;
  `alt+up`/`alt+down` jumps (verified by message-line rewrite at viewport top);
  `/markers status|off|on` (off removes glyphs from next frame, on re-wraps — debug
  trace `uninstallRail: document restored` / `installRail: WRAPPED document`);
  clean `/quit` exit (70 ms).
  Optional manual checks (not scripted, low risk): terminal resize, compaction,
  `/tree` navigation, resuming an old session — all reuse the same verified paths
  (structural-snapshot cache key + detection duck-type).

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
- **Do NOT touch:** pi dist files, other extensions, built-in scrollbar/search/
  `scrollToEndIndicator` behaviors.

## 6. Next Immediate Action
- **Done.** If revisiting: re-run the three test commands in the README; any
  transcript-tree shape change in a future pi release would first surface as
  `collect: … → offsets: []` with `MESSAGE_MARKERS_DEBUG` set, and the fix point is
  `isUserMessageLike` / `collectUserMessageOffsets` in
  `~/.pi/agent/extensions/message-markers.ts`.
