# PLAN.md — Active Technical Implementation Plan & State Anchor

## 1. Human Requirement (Original Intent)
> "I can't see the clickable icons. I expect a clickable dot for every human prompt that
> happened in the Chat — including messages that happened **before** the extension was
> activated. The dots should sit on the right side of the window at the edge of the chat
> cutout, **~20px (2rem) to the left of the scrollbar** (scrollbar stays at the right
> edge), **~15px apart from each other**, **vertically centered**, forming a vertical
> line in the same direction as the scrollbar. Dots must be **clickable**."

Recon findings that explain "I can't see them" (verified from source + PTY frame dump):
- The rail renders, but at `col = width - 2` — the **last 2 columns of the window**,
  flush against the scrollbar column. pi's scrollbar occupies exactly one column,
  `box.rect.x + box.rect.width - 1` (layout.js `getScrollbarGeometry`), and the
  transcript scrollbar is `"auto"` (chat-viewport.js), so content width = full box
  width and the scrollbar paints **over** the last content column. A dim `·` one column
  left of that track is effectively invisible.
- Dots are one row apart already (≈15px line height) and viewport-centered — those
  requirements are already met; the fix is **position, visibility, clickability,
  capacity, and detection robustness**.

## 2. Technical Architecture & Data Flow
- **Core Mechanism:**
  1. **Reposition:** new pure `railMarkerColumn(width) = width - 1 - SCROLLBAR_GAP`
     with `SCROLLBAR_GAP = 3` columns (≈20–27px at typical 7–9px cell widths; px is
     font-dependent in a terminal, columns are the only unit available). Dots never
     touch the scrollbar column.
  2. **Clickability:** implement `handleMouse(event)` on `RailDocument`. Proven flow
     (tui-alt-screen.js `handleMouseEvent`): TUI-level search/scroll-to-end/**
     scrollbar** handlers only claim their own geometry (scrollbar = 1 column, our
     dots are 3 columns left of it); otherwise `dispatchMouseToLayout()` walks
     `getLayoutBoxesAt()` **deepest box first** — the scroll node's child box **is our
     `RailDocument`**, and `ScrollView` has no `handleMouse`, so our handler runs
     first. Event coords are already document-relative (`y = screenY - (contentY -
     scrollTop)` ⇒ document row; `x = screenX - box.rect.x` ⇒ content column).
     - `press` inside the marker band (|x - col| ≤ 1): return `{ handled: true,
       render: false }` → blocks text-selection start on the rail, records no action.
     - `click` (release on same spot) inside the band: map row → marker index →
       `transcript.scrollTo(rows[index], { disableFollow: true })` + `requestRender()`,
       return `{ handled: true }` (render defaults true). **Jump on click, NOT on
       press** — jumping on press would shift the document under the cursor, and the
       synthesized release-click would re-map to a *different* marker (double jump).
     - Outside the band: return `undefined` → existing selection/scroll behavior
       unchanged.
     - `…` ellipsis rows map to `index: null` → clicks do nothing.
  3. **One dot per prompt, older messages included:** detection is already stateless
     over the whole rendered transcript (every rendered user message gets a marker —
     including pre-activation/resumed sessions, because the transcript tree is walked
     on install and refreshed by structural snapshot). Make the walker **fully
     recursive** (today it only finds user messages at document-child level or one
     level below) so any pi tree reshuffle still yields every prompt.
  4. **Capacity so "every" prompt gets a dot:** `railCapacity(vh)` changes from
     `clamp(vh/2, 3, 15)` to `max(3, vh - 2)` — up to (visible rows − 2) dots at one
     dot per row (the "15px apart" spacing); beyond that the existing
     `windowIndices` window + `…` still applies.
- **Data / Control Flow:**
  - `[per-frame render] → computeRail(width, rows, scrollTop, vh, docHeight, theme) → { marks[{text,index}], top, col } → compositeTuiLine per mark`
  - `[SGR mouse press/click] → TuiAltScreen.handleMouseEvent → dispatchMouseToLayout (deepest-first) → RailDocument.handleMouse → (press: handled) / (click: markerIndexForClick → MarkerRail.jumpTo(index) → scrollTo + requestRender)`
  - `[session start/resume → installRail → full-tree walk → markers for ALL prior user messages]`
- **Acceptance Criteria:**
  1. In a 100-col fullscreen session, dots render at column 96 (0-based) — 3 columns
     left of the scrollbar column (99); active `▸` + inactive `·`, ~1 row (≈15px)
     apart, vertically centered over the transcript viewport.
  2. Clicking an inactive dot scrolls the transcript so that user message starts at
     the viewport top (e2e: click msg-1 dot after msg-2 sent ⇒ "msg alpha" line
     appears at viewport top). Clicking outside the band still starts normal text
     selection (no regression).
  3. Resuming a pre-existing 4-user-message session (`pi --session <jsonl>`) with the
     extension active shows 4 markers (3 `·` + 1 `▸`) **before any new message is
     sent** — backward compatible.
  4. A user message nested 3 levels deep in the transcript tree still gets a marker
     (unit test for recursive detection).
  5. A 40-row viewport can show up to 38 dots (unit test for new capacity).
  6. `alt+up`/`alt+down` jumping, `/markers on|off|status`, regular-mode passthrough,
     and exception-safety all still pass (regression: unit 19+, smoke, e2e).

## 3. Surgical File Map (Strict Scope Boundary)
- `~/.pi/agent/extensions/message-markers.ts`
  - Lines ~168–176: `railCapacity(viewportHeight)` — new formula `max(3, vh - 2)`.
  - Lines ~121–145: `collectUserMessageOffsets` — replace 1–2-level walk with a
    recursive `walk(node)` (user-like ⇒ record row; rendered component ⇒ row +=
    render height; container ⇒ recurse).
  - Lines ~302–307 (in `MarkerRail.overlay`): replace `const col = width - 2` with
    shared pure `computeRail(...)` (new, exported) returning `{ marks: RailMark[];
    top; col }`, `railMarkerColumn(width)`, `markerIndexForClick(docRow, scrollTop,
    top, marks)`; add `RailMark { text: string; index: number | null }`.
  - New method `MarkerRail.jumpTo(index)` (extract target-scroll logic from `jump`)
    — `jump(direction)` keeps working via it.
  - `RailDocument` (lines ~340–360): add `handleMouse(event)` (press/click/else
    branches per §2); keep leaf shape (no layout node).
- `~/.pi/agent/projects/message-markers/tests/message-markers.test.ts`
  - Update `railCapacity` expectations (vh=14→12, vh=40→38, vh=4→3, vh=2→3).
  - Add: 3-level nested user message detection; `railMarkerColumn(100) === 96`,
    `railMarkerColumn(8) === 4`; `markerIndexForClick` mapping (hit/miss/ellipsis).
- `~/.pi/agent/projects/message-markers/tests/message-markers.load-smoke.ts`
  - Add: `RailDocument.handleMouse` — click in band scrolls to the right row and
    returns `{handled:true}`; press in band returns `{handled:true}` without
    scrolling; click outside band returns undefined and doesn't scroll; click on
    `…` row does nothing.
- `~/.pi/agent/projects/message-markers/tests/message-markers.pty-e2e.py`
  - Extend final PTY test: (a) assert dot column == 96 in a rendered frame; (b) send
    SGR mouse press+release (`\x1b[<0;x;yM` / `\x1b[<0;x;ym`, 1-based) on msg-1's dot
    (located by frame scan) and assert "Jump test alpha" moves to viewport top;
    (c) NEW backward-compat run: `pi --session
    /home/julian/.pi/agent/sessions/--tmp--/2026-11-03T18-13-51-704Z_01a1a29e-*.jsonl`
    (4 user messages from the last verified run) with **no input** ⇒ expect 4 marker
    glyphs in the right column, then clean `/quit`.
- `~/.pi/agent/projects/message-markers/message-markers.ts` + `README.md` — sync copy
  + docs (click usage, 3-col offset, capacity, resume behavior).
- `~/.pi/SPEC.md` — final status update after green.

Do NOT touch: pi dist files, other extensions, pi's selection/scrollbar/search
handlers (we only *add* a deeper-box handler they already consult).

## 4. Atomic Execution Checklist
- [x] **Step 1 (TDD red):** unit tests updated (capacity formula, `railMarkerColumn`,
      `markerIndexForClick`, recursive `collectUserMessageOffsets`, `computeRail`);
      red confirmed (`SyntaxError: ... does not provide an export named 'computeRail'`).
- [x] **Step 2:** pure changes implemented: `railCapacity = max(3, vh - 2)`, fully
      recursive `collectUserMessageOffsets` + `isCompositeContainer`, `computeRail` /
      `railMarkerColumn` / `markerIndexForClick` / `RailMark` / `RailLayout` /
      `SCROLLBAR_GAP_COLUMNS`, `RailState.docHeight`; 29/29 unit green.
- [x] **Step 3:** `MarkerRail.jumpTo` (shared by keyboard + click),
      `MarkerRail.mouse` (band-only claim, jump on click), `RailDocument.handleMouse`
      (rail first, try/catch, fall through to inner); 6 new mouse load-smoke tests;
      16/16 green.
- [x] **Step 4:** PTY e2e rewritten as a **self-contained 3-session driver**
      (fixture / fresh / resume) with a built-in terminal emulator (grid + cursor +
      CSI parsing). Checks: rail at col 96 (independent `▸ ` search), 1 row per dot,
      vertically centered, `alt+up` jump, **real SGR left-click on a dot jumps**,
      resumed session shows **4 markers for pre-activation messages**, clean `/quit`.
      10/10 checks green (twice). Deviation from plan (improvement): instead of
      resuming a hardcoded pre-existing session, the driver builds its own 4-message
      fixture session — deterministic, and unaffected by compaction of old sessions.
      Debug log confirmed: `mouse: click → jumpTo 1` with rail `{top:2, col:96}`.
- [x] **Step 5:** regression green: unit 29/29, smoke 16/16, e2e 10/10, print-mode
      `pi -p "Reply with exactly: OK"` → `OK`; project copy re-synced (byte-identical);
      README + SPEC updated.

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT jump on `press`** — the synthesized release `click` would re-map through the
  already-scrolled document and jump a second time.
- **Do NOT double-apply scrollTop** in `handleMouse`: the scroll child box is already
  translated by `-scrollTop`, so `event.y` IS the document row.
- **Do NOT place markers in column `width - 1`** — the "auto" scrollbar paints over
  that exact column; keep ≥3 columns of gap (`SCROLLBAR_GAP`).
- **Do NOT return a mouse result outside the marker band** — `undefined` is what lets
  pi's text selection, right-click paste and scroll-to-end keep working.
- **Do NOT treat `…` rows as jump targets** (`index: null`).
- **SGR mouse bytes in PTY tests are 1-based** (`ESC [ < b ; col ; row M`), while all
  internal math is 0-based.
- **px ≠ columns:** terminals expose only cell units; "20px/2rem" is implemented as
  3 columns (≈20–27px) and documented as font-dependent. "15px between dots" = 1
  terminal row (typical line height 15–18px).
- **Compaction caveat (unchanged from SPEC):** compacted-away messages are not
  rendered, hence have no marker and no jump target; all *rendered* prior messages —
  including pre-activation ones — always do.
- **Monkey-patch/install hygiene unchanged:** idempotent start-patch,
  `doc instanceof RailDocument` re-sync guard, disabled-guard, try/catch everywhere.

## 6. Next Immediate Action
- **Done.** All five steps complete and verified (see §4). To re-verify:
  `node tests/message-markers.test.ts && node tests/message-markers.load-smoke.ts &&
  python3 tests/message-markers.pty-e2e.py` (run e2e from `/tmp`).
