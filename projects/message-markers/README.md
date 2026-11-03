# message-markers — right-edge marker rail for your own messages

A pi agent extension for long sessions. In **fullscreen TUI mode** it draws a vertical
marker rail on the **right side of the window, vertically centered** — **one clickable
dot per user message you sent** — with the marker of the user message you are currently
viewing highlighted. You can jump between your own messages with a keypress or by
**clicking a dot**.

Installed (live): `~/.pi/agent/extensions/message-markers.ts` (auto-discovered, single
file, no runtime dependencies). This project directory holds the canonical copy
(`message-markers.ts`) plus the tests.

Verified against pi **1.5.0**.

## Usage

| Action | How |
| --- | --- |
| Rail on (default) | On by default in fullscreen; `/markers on` re-enables |
| Rail off | `/markers off` — removes the rail, restores the original document |
| Status | `/markers status` — reports on/off + tracked user-message count |
| Jump to previous user message | `alt+up` |
| Jump to next user message | `alt+down` |
| Jump to a specific user message | **left-click its dot** in the rail |

The rail shows `·` for each user message and `▸` (accent color) for the one currently in
view; when there are more markers than fit, it shows a window centered on the active
marker with `…` on the truncated ends. Markers follow the viewport while you scroll.

Jumping (keyboard or click) scrolls the transcript so the target user message starts at
the top of the transcript viewport. Plain typing and other keys are unaffected; when the
rail is off (or there is no transcript to jump within) `alt+up`/`alt+down` pass through
untouched.

### Geometry (pixels as terminal cells)

- The rail sits **3 columns left of the right edge** — i.e. left of the scrollbar, which
  owns the last column. In a 100-column terminal the dots are at column 96 (0-based),
  the scrollbar at column 99. 3 columns ≈ the requested "20px" gap; a terminal exposes
  cell units, not CSS pixels.
- Dots are spaced **1 row apart** (≈ the requested "15px").
- The marker block is **vertically centered** in the transcript viewport, in the same
  vertical direction as the scrollbar.

### Clicking

- Left-click a dot (or the active arrow) to jump to that user message. The click is
  consumed: the scrollbar drag, text selection, and right-click paste behavior are left
  untouched, and only the narrow band around the rail column (±1 column) is claimed —
  every other click passes through exactly as before.
- Clicking a `…` row does nothing (it is not a jump target).
- When the rail is off, all clicks pass through.

### Keybinding notes

- pi's key parser encodes alt+arrows as **ESC + letter** (`ESC p` = alt+up,
  `ESC n` = alt+down — vim-keys style). The extension uses pi's own `matchesKey()`, so
  whatever your terminal sends, the same parsing pi applies to its built-in
  keybindings applies here.
- While the rail is **on**, the extension consumes `alt+up`/`alt+down` before pi's
  built-in bindings. Note `alt+up` is also pi's default key for
  `app.message.dequeue` (restore queued messages) — while the rail is active it will
  jump instead. Turn the rail off with `/markers off` (or remap the extension's keys)
  if you rely on that behavior.

## Design notes

- **Fullscreen only.** In regular mode the terminal owns scrollback; the app cannot
  anchor a visible window, so the rail renders nothing there. Mode switching is never
  blocked because the rail is **not** an overlay.
- **Mechanism: document wrapper, not overlay, not layout-root wrap.** The extension
  wraps the transcript `ScrollView`'s child (the document `Container`) in a leaf-shaped
  `RailDocument` whose `render()` renders the original document and composites the rail
  onto the right edge with the exported `compositeTuiLine()`. The fullscreen layout
  system renders the scroll view's child as a leaf component every frame
  (`renderLayoutFrame` → scroll node → `renderCached(ctx, node.component, width)`), so
  the wrapper's output is guaranteed to be the content that gets painted, at the
  correct `scrollTop`. Wrapping the *layout root* instead does not work:
  `renderLayoutFrame` walks the `LAYOUT_NODE` tree and never calls the root component's
  `render()`, so a root-level overlay is never referenced.
- **Re-attach point:** a new fullscreen TUI (and layout root) appears on startup and on
  every mode switch, so the extension patches `TuiAltScreen.prototype.start` exactly
  once (idempotent, `globalThis` symbol guard) and installs the wrapper right after
  `start()`, plus a `session_start` `ctx.ui.custom()` capture for the initial TUI
  (which starts before extensions load). Re-installation is idempotent
  ("already wrapped, re-synced").
- **User-message detection (fully recursive):** user messages are matched by
  duck-typing the runtime shape of pi's `UserMessageComponent` (`text` string +
  `markdownTransformers` array, no `message` field). OSC 133 zone markers are *not*
  used — tool-call-free assistant messages embed them too. The walk is **fully
  recursive** (with a depth guard): user-shaped nodes are recorded wherever they sit
  (this is what makes **resumed sessions and pre-extension-activation prompts** get
  markers — their components live deeper in the tree), components with their own
  `render` are measured as opaque leaves (never descended into), and plain
  `Container` nodes (those rendering via `Container.prototype.render`) are descended.
  Note the container test is `render === Container.prototype.render`, not
  `typeof render === "function"` — `Container` inherits a `render` from `TuiBase`
  through the prototype chain, so a plain type check would treat containers as opaque
  leaves and find nothing.
- **Offsets:** start row = cumulative rendered height of preceding transcript
  children; cached, keyed by a structural snapshot of the transcript tree, so
  streaming growth of the last assistant message does not re-walk per frame.
- **Capacity:** one dot per visible row of the transcript viewport (`max(3,
  viewportHeight - 2)`), so long sessions get a full dot-per-message rail instead of a
  7-dot window; the `…` windowing remains for pathologically tall viewports.
- **Mouse:** the wrapper implements `handleMouse`. pi dispatches layout mouse events
  deepest-first; events inside the rail band (±1 column around the marker column) are
  claimed by the rail — `press` is swallowed (so no selection starts), the `click`
  (release on the same component) maps the document row through the *current* rail
  geometry and jumps via the shared `jumpTo(index)`. Events outside the band return
  `undefined` and fall through to the wrapped document (and pi's scrollbar/selection/
  scroll-to-end handling above it). Jumping happens on `click`, never on `press` —
  jumping on press would move the document under the cursor and double-jump on
  release. The wrapper's layout box is the document's box (translated by `-scrollTop`),
  so no extra scroll offset is applied in `handleMouse`.
- **Active marker:** the last user message whose start row is at or above the viewport
  bottom; falls back to the first message when the viewport is above all of them.
- **Exception-safe:** every install path is wrapped in try/catch; a failure only
  disables the rail (and, when `MESSAGE_MARKERS_DEBUG` is set, logs to the debug file).
  The session and TUI keep running regardless.
- **Stale-ctx pitfall (fixed 2026-11-03):** the theme is read through the session's
  `ctx` (`ctx.ui.theme`), and that ctx is **invalidated the moment pi replaces the
  session** (resume / new / fork / reload) — the old ctx's `ui` getter then throws
  (ExtensionRunner.assertActive). The rail composites markers on **every render
  frame**, and TUI frames can run during the replacement window (before the new
  session's `session_start` re-captures), so a bare `() => ctx.ui.theme` closure
  crashed the whole process on session resume (uncaught exception in the render
  loop; see `~/.pi/agent/crashes.json`, 5 entries, pi 1.5.0). The theme is now read
  through `makeThemeReader(ctx)`: live reads while the ctx is active, fallback to the
  last successfully read theme (fallbackTheme before the first read) while stale,
  and it picks up live theme changes again once the replacement's `session_start`
  re-captures a fresh ctx. Rule: **never let a render-path closure hold a session
  ctx**; treat any ctx captured at `session_start` as stale from the next session
  swap until a new one arrives.

## Limitations

- Right-edge 2-column markers (in a 3-column gap left of the scrollbar) may overtype
  the last 2 content columns of a very long transcript line (the rail is drawn on top;
  `compositeTuiLine` skips Kitty image lines).
- Markers reflect what is *rendered* in the transcript tree; hidden/collapsed
  segments and **compacted-away messages** have no markers. Resumed sessions show
  markers for every user message that is actually rendered.
- After `/reload` the rail state resets to the default (on).

## Debugging

```sh
MESSAGE_MARKERS_DEBUG=/tmp/mm-debug.log pi
```

Writes install/uninstall/overlay/collect traces. No effect on rendering otherwise.

## Tests

```sh
# pure logic (rail geometry, column, active-index math, windowing, capacity,
# detection, offsets, click mapping)
node ~/.pi/agent/projects/message-markers/tests/message-markers.test.ts

# entry-point smoke (registration, idempotent patch, /markers, disabled guard,
# mouse pass-through)
node ~/.pi/agent/projects/message-markers/tests/message-markers.load-smoke.ts

# real fullscreen sessions over a PTY (self-contained; builds its own fixture):
#   0) 4-message fixture session
#   1) fresh session: rail at column 96 (3 cols left of the scrollbar), 1 row per
#      dot, vertically centered, alt+up jump, SGR left-click on a dot jumps, /quit
#   2) resume the fixture: 4 markers (3 dots + active) for pre-activation messages
python3 ~/.pi/agent/projects/message-markers/tests/message-markers.pty-e2e.py
```

All three pass on pi 1.5.0 (2026-11-03): 29/29 unit, 16/16 smoke (incl. the
stale-ctx render regression tests), 10/10 e2e.
`MM_DEBUG=1` makes the e2e driver print reconstructed screens at checkpoints.

## Files

- `message-markers.ts` — the extension (canonical copy; identical to the live one).
- `tests/message-markers.test.ts` — unit tests for the pure exports.
- `tests/message-markers.load-smoke.ts` — load/entry smoke tests.
- `tests/message-markers.pty-e2e.py` — end-to-end driver (spawns `pi` in a 14×100 PTY).
