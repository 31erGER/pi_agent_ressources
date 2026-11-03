# SPEC.md — Active Technical Specification & State Anchor

## 1. Human Requirement (Original Intent)

**v1 (done):** `/stats` slash command → escapeable dashboard overlay (not chat flow) with
tokens, context window + what is in it, loaded context files / skills / extensions; usable
mid-inference without interrupting the run.

**v1.1 (done):**
1. **Global usage counters** — every loaded extension and skill listed with a **global
   counter** (across ALL sessions) of how often it was used / executed, plus a **date it was
   introduced**, so the user can manage (prune) them.
2. **Performance section** — average **tokens per second**: whole session, last 10 turns,
   last 100 turns.

Both features follow the extension-creator → vibe-to-spec workflow and TDD (failing test
first, per my addendum).

**v1.2 (done):** fix the live dashboard popup — (a) bottom border was missing (overlay
`maxHeight` sliced the box; root cause: overlay bounds are stale/undefined during
`render()`, see §5), and (b) the panel could not be scrolled to the bottom (scroll
position was reset to 0 on every render frame); add **mousewheel scrolling**
(`handleMouse` for alt/fullscreen mode + raw SGR passthrough in `handleInput` for
regular mode).

**v1.3 (done):**
1. **Tools in the stats panel** — treated exactly like skills/extensions:
   - *loaded tools* listed (right column), parsed from the `<tools>` section of the
     FINAL system prompt (`- name: description` lines); dynamic/MCP tools included
     (the section reflects `toolsAdded`).
   - *global tool-use counters* — every `tool_execution_start` bumps
     `UsageData.tools[<toolName>]` (persisted like skills/extensions);
     introduced date = birthtime of `dist/core/tools/<name>.js` for the built-in set
     (bash, edit, find, grep, ls, powershell, read, write), else the pi package
     date (i.e. "introduced with this pi version").
2. **Two-column layout** — split all sections into two meaningful groups and divide
   the panel vertically:
   - **LEFT = session** (live state): model/session/cwd/status, context window +
     system-prompt-vs-messages split, system prompt sections, messages by role,
     tokens (session) + last turn, performance.
   - **RIGHT = environment** (loaded + global): loaded resources (context files,
     skills, prompts, extensions), tools, usage (global) for skills/extensions/tools.
   - Box border gets a middle divider (`┬`/`┴`); full-width `stats` title row left,
     `environment` right; footer hint stays full-width. NO information deleted.
   - Overlay width 80% → 92% for comfortable columns; height/scroll logic unchanged
     (box still exactly `floor(rows·0.88)` lines, bottom border always drawn).
   - Layout core: `buildStatsColumns(d, leftWidth, rightWidth)` → `{left, right, footer}`;
     the component renders `│ left │ right │` rows with a middle divider through the
     top/bottom borders (`┬`/`┴`); `buildStatsLines` composes the same columns into
     flat rows (used by the integration eyeball render + tests).

**v1.4 (done):** new **changes** section (LEFT column) — **added/deleted lines** in
the session cwd, **code and text combined** (all files, single ± numbers), computed
the **most efficient way**: git (user approved git where performant).
1. *Semantics (session-scoped):* baseline = `HEAD` captured at session start (in-memory
   only, zero persistence). The diff = `git diff --numstat <baseline>` (baseline→working
   tree, so commits made DURING the session still count) + untracked files via
   `git ls-files --others --exclude-standard -z | xargs -0 -r wc -l` (their lines count
   as added). No baseline (failed rev-parse) → fall back to `HEAD`. Binary files count
   as files with 0 lines.
2. *Efficiency:* ONE shell spawn per refresh containing both git invocations
   (`--no-optional-locks`), 5 s timeout, **TTL cache 2 s** keyed by cwd+baseline with
   in-flight dedupe — live refreshes never re-spawn within the window; result is merged
   into the dashboard asynchronously (first frame renders immediately, section appears
   when git answers).
3. *Display* (LEFT, between `tokens (session)` and `performance`), max 4 lines:
   ```
   changes (this session, git)
     +1.2k  -56  · 12 files
     +89 untracked (3 files)
     top: stats.ts +40 -2 · README.md +15
   ```
   `git` result states: `undefined` = pending (`…`), `not-repo` = `(not a git repo)`,
   `unavailable` = `(git unavailable)`.

**v1.5 (CURRENT):** three features, extension-skill workflow + TDD:
1. **`last turn` row in the performance section** (LEFT) — in addition to `session`,
   `last 10`, `last 100`: rate of the single most recent work item: `out(last) / (at(last) − at(prev))`;
   `—` when there is <2 items or zero span. Reuses the existing `WorkItem` list.
2. **MTP acceptance rate (only if queryable from LM Studio)** — VERIFIED QUERYABLE: a
   completion response from the LM Studio server (`$LM_STUDIO_BASE_URL`, default
   `http://localhost:1234`) carries a `stats` object with
   `total_draft_tokens_count` / `accepted_draft_tokens_count` / `rejected` / `ignored`
   (present on both `/v1/completions` and `/v1/chat/completions`; empty `{}` when no
   speculative decoding). Acceptance rate = `accepted/total` (total>0).
   - **Cheap probe:** on `/stats` open, only when the current model's provider is
     `lmstudio`: one small `/v1/chat/completions` request (`max_tokens: 32`,
     temperature 0, trivial prompt, 5 s timeout) → parse `stats` → show in the
     performance section: `mtp (lm studio)  78% accepted (96/123 drafts)`.
   - 60 s result cache (no re-probe on live refresh); probe failure → no row at all
     (feature silently absent, never an error in the panel).
3. **Global performance-impact rating (1 = cheap … 5 = costly)** for every loaded
   extension and tool:
   - **New measurement store** `~/.pi/agent/perf-stats.json` (env override
     `PI_STATS_PERF_FILE`): `{ version: 1, tools: { <name>: { calls, totalMs, maxMs,
     firstSeen, lastUsed } } }`, fed by the `tool_execution_end` event's `durationMs`
     (monotonic, measured by pi; absent → fall back to start→end wall clock pairing,
     else skip). Display-only, same read-modify-write pattern as UsageStore.
   - **Criteria** written to `PERFORMANCE-RATING.md` in this project dir (bands +
     weights, see §2 v1.5); three measurable factors per item:
     1. **duration** (measured avg ms/call; no data → 1)
     2. **frequency** (measured global calls from the usage store)
     3. **static** (measured: source/impl bytes; extensions also count of `pi.on(`
        subscriptions; +1 if the extension renders per-frame TUI — `ui.custom` /
        `showOverlay` / `registerComponent` in source; tools without a resolvable impl
        file → neutral 3)
   - **Rating** = `clamp(1, 5, round(0.5·duration + 0.3·frequency + 0.2·static))`.
   - **Deliverables:** (a) criteria doc `PERFORMANCE-RATING.md`; (b) measurement data
     in the perf store file; (c) `perf/rate.mjs` generator (project dir) →
     `perf/perf-ratings.json` + printed table for ALL loaded extensions + tools;
     (d) a compact RIGHT-column section in the dashboard, `perf rating` (top items by
     rating: `name  R · avg ms/call · calls`), computed by the same `rateItem()` the
     script uses (single source of truth).

## 2. Technical Architecture & Data Flow (v1.1)

- **Core Mechanism (usage):** `stats.ts` gains a `UsageStore` (JSON file at
  `getAgentDir()/usage-stats.json` — global across sessions, never a session entry).
  Counters are incremented by two always-on listeners registered at extension **load time**
  (not only while the dashboard is open):
  - `input` event: text starting `/skill:<name>` → skill use (raw text is visible BEFORE
    skill expansion; extension commands are NOT visible here — they short-circuit earlier,
    so those self-report, see below).
  - `tool_execution_start`: `read` tool with `path` ending in `SKILL.md` → implicit skill
    use (agent consulting the skill).
  Other extensions self-report via exported helpers from `stats.ts` (shared jiti module
  instance = shared store): one line `trackExtensionRun(import.meta.url)` in their
  command handler / main event handler. Read-modify-write per event (file is tiny; safe
  across processes); corrupt file → start fresh, never crash.
- **Usage semantics (documented in README):**
  - skill use = `/skill:name` invocations + `read` of its SKILL.md (both counted)
  - extension run = invocation of a command it registered (self-reported); for
    event-driven extensions: their main event action (self-reported)
  - introduced date = file `birthtime` (fallback `mtime`); shown as YYYY-MM-DD
- **Core Mechanism (performance):** pure `perfStats(items)` over "work items"
  (timestamped generated-token amounts). Work items come from session entries: assistant
  messages + compaction + branch_summary entries that carry `usage` (ISO `timestamp` from
  `SessionEntryBase`). Generated tokens = `usage.output` (already INCLUDES reasoning
  tokens — do not add `reasoning`). tps = Σoutput / span seconds; null (render `—`) when
  <2 items or span ≤ 0. Windows: all items, last 10, last 100 (by entry order).
- **Data / Control Flow:** same as v1; `collectStats(pi, ctx, opts?)` now also reads the
  usage store + computes perf; `buildStatsLines` renders two new sections:
  `usage (global · all sessions)` and `performance (output tokens/s)`.
- **Acceptance Criteria (v1.1):**
  1. `/stats` dashboard lists every loaded skill and extension with a global use/run
     counter and an introduced date (YYYY-MM-DD).
  2. Counters persist across sessions/processes in one JSON file
     (`~/.pi/agent/usage-stats.json`); a new session sees previous counts.
  3. Running `/stats` increments the stats extension's own counter; running `/lmstudio` /
     `/token-counter` increments theirs; typing `/skill:x` or the agent reading a
     SKILL.md increments the skill's counter.
  4. Dashboard shows tokens/s for session / last 10 / last 100 with generated-token total
     and duration; single-message or zero-span windows render `—`.
  5. All new pure logic + store + factory wiring unit-tested (failing tests first);
     integration test renders the new sections against a real session; `tsc --strict`
     clean; pi's real loader still loads all extensions without errors.

## 3. Surgical File Map (Strict Scope Boundary)

- `~/.pi/agent/extensions/stats.ts` — v1.1: `UsageStore` class + pure helpers
  (`attributeSkillInput`, `skillUseFromRead`, `tokensPerSecond`, `perfStats`,
  `formatDuration`, `formatAddedDate`, `fileIntroducedDate`), exported
  `trackExtensionRun`/`trackSkillUse` self-report helpers, load-time listeners, new
  dashboard sections, `collectStats` extended.
- `~/.pi/agent/extensions/lmstudio.ts`, `token-counter.ts`, `notify-on-settle.ts`,
  `session-name-border.ts`, `reload-resources.ts` — **one-line instrumentation each**
  (import + `trackExtensionRun(import.meta.url)` at command/main-action point).
- `~/.pi/agent/usage-stats.json` — runtime artifact (created on first record).
- `~/.pi/agent/projects/stats-dashboard/test/stats-core.test.ts` — new unit tests.
- `~/.pi/agent/projects/stats-dashboard/test/stats-integration.test.ts` — new section
  render checks against a real session + store round-trip.
- `~/.pi/agent/projects/stats-dashboard/README.md` — v1.1 section.
- v1 files unchanged in spirit (dashboard component gains two sections only).

## 4. Atomic Execution Checklist (v1.5 — DONE)

- [x] **Step 1:** SPEC v1.5 (this file).
- [x] **Step 2:** RED unit tests — `lastTurnWindow`, `parseMtpStats`,
      `PerfStore` (record/persist/corrupt/env), `rateItem` bands + composite, static
      source metrics, performance section shows `last turn`, `perf rating` section in
      RIGHT column, factory `tool_execution_end` → perf store. Verified red (missing
      exports), then green.
- [x] **Step 3:** implemented in `stats.ts`: `PerformanceSection.last`, `parseMtpStats` +
      `probeMtpAcceptance` (fetch, 5 s timeout, 60 s cache, provider-gated),
      `PerfStore` + `tool_execution_end` handler, `rateItem`/`staticSourceMetrics` +
      `data.ratings` in `collectStats`, dashboard rows (LEFT `last turn` + `mtp`,
      RIGHT `perf rating`). Unit green: **53 tests**.
- [x] **Step 4:** `perf/rate.mjs` + `PERFORMANCE-RATING.md` in project dir; run against
      the REAL stores → `perf/perf-ratings.json` (10 rated items: 6 extensions + 4
      tools with usage data; ratings 1–2, durations pending first live recordings).
- [x] **Step 5:** integration — MTP probe vs the LIVE LM Studio (qwen/qwen3.8-27b):
      **88% accepted (21/24 drafts)**, cache identity verified; perf-store event flow
      via factory handler on a temp file (durationMs, wall-clock fallback ≥1 ms, orphan
      end skipped); `tsc --strict` clean; pi's real loader 0 errors (all 6 extensions).
- [x] **Step 6:** README v1.5 (last turn, MTP, rating criteria pointer) + SPEC §5
      pitfalls + §6 next action.

### v1.4 checklist (done)
 (v1.1)

- [x] **Step 1:** Recon events/commands/usage shapes + SPEC update (this file).
- [x] **Step 2:** Failing tests for usage store, attribution, perf (verify: red with
      `SyntaxError: does not provide an export named 'UsageStore'`).
- [x] **Step 3:** Implement store + pure helpers + `collectStats` extension (verify: unit
      tests green).
- [x] **Step 4:** Dashboard sections + load-time listeners + self-report exports (verify:
      33/33 unit tests green).
- [x] **Step 5:** Instrument the 5 sibling extensions (verify: real loader loads all six,
      0 errors; jiti client self-report test green).
- [x] **Step 6:** Integration test (real session perf render + store round-trip) +
      `tsc --strict` + real-loader check (verify: 3/3 checks green; real `/stats` handler
      self-reported via import.meta.url under jiti).
- [x] **Step 7:** README v1.1 sections (verify: match rendered output).

### v1.3 (tools + two-column layout)

- [x] **Step 1:** SPEC §1 v1.3 (this file).
- [x] **Step 2:** Failing tests (verify: red with `SyntaxError: does not provide an
      export named 'buildStatsColumns'`): `parseToolList`, `UsageStore.recordTool` +
      old-file migration, `collectStats` tools from prompt + counters, `buildStatsColumns`
      (full + empty placeholders), two-column component render (divider borders),
      `buildStatsLines` composition, factory tool-counter assertions.
- [x] **Step 3:** Implement: `parseToolList`, `UsageData.tools` + migration,
      `trackToolUse` + factory wiring, `toolIntroducedDate`/`piPackageRoot`,
      `buildStatsColumns`, two-column `StatsDashboard.render`, overlay width 92%,
      wrapped() continuation indentation (verify: 42/42 unit tests green).
- [x] **Step 4:** `tsc --strict` + integration (real-session two-column render with
      tools + usage tools) + pi's real loader (verify: typecheck clean, 3/3 checks green,
      all six extensions load with 0 errors; `piPackageRoot` resolves through the
      node_modules chain, `toolIntroducedDate` returns install date for built-in +
      non-built-in tools).
- [x] **Step 5:** README v1.3 (Layout section, tools row, store shape, counting
      semantics, verification numbers).

### v1.4 (changes section — added/deleted lines)

- [x] **Step 1:** SPEC v1.4 (this file) — verify: §1 + checklist updated.
- [x] **Step 2:** Failing unit tests for `parseNumstat`, `parseUntrackedWc`,
      `buildStatsColumns` changes section (changes / not-repo / unavailable / pending)
      — verify: red (`SyntaxError: does not provide an export named 'parseNumstat'`).
- [x] **Step 3:** Implement pure parsers + `collectGitChanges` (single shell spawn,
      `--no-optional-locks`, 5 s timeout, 2 s TTL cache + in-flight dedupe) +
      `captureGitBaseline` on `resources_discover` + LEFT-column section + async
      merge in handler/refresh — verify: 45/45 unit tests green.
- [x] **Step 4:** Integration: real temp git repo (init/commit/modify/untracked/commit
      again) proves session-scoped counts (+5 -2 pre-commit; +12 -2 post-commit,
      i.e. committed work still counts) + not-a-repo state + TTL cache identity +
      resources_discover → baseline capture — verify: 4/4 checks green;
      `tsc --strict` clean; pi's real loader still loads all six extensions, 0 errors.
- [x] **Step 5:** README v1.4 section (semantics, efficiency notes, display states).

## 5. Negative Knowledge (Guardrails & Taboos)

- **Do NOT touch:** pi package sources, session files, other extensions beyond the
  one-line instrumentation listed in Section 3 (and keep that diff minimal + documented).
- **Do NOT** queue or call `pi.sendMessage()`; **do NOT** `waitForIdle`/`abort`;
  **do NOT** persist anything to the session (zero-trace rule stays — the global counter
  lives in a separate file, which is allowed: it is not session data).
- **Do NOT** add `usage` summary entries to perf work items (they are rollups → would
  double-count); perf uses assistant + compaction + branch_summary entries only.
- **Do NOT** add `usage.reasoning` to output — `output` already includes it.
- **Known Pitfalls (new):**
  - Extension commands execute BEFORE the `input` event (`AgentSession.prompt` →
    `_tryExecuteExtensionCommand` first) — they are invisible to global listeners;
    hence the one-line self-report convention.
  - pi's extension loader rejects modules without a function default export (loader.js
    L487) — a standalone helper file in `extensions/` would break startup; the shared
    helpers must be exported from `stats.ts` instead.
  - All `SessionEntryBase` timestamps are ISO **strings** → `Date.parse` for perf.
  - `birthtime` can be 0/undefined on some filesystems → fallback chain
    birthtime → mtime → null (render `?`).
- **Known Pitfalls (v1, carried):** see git/README — chars/4 estimation, post-compaction
  null context, section-tag parsing, ANSI in names, package.json ESM marker, jiti-only
  bare-specifier resolution via `~/.pi/agent/node_modules` symlinks.
- **Known Pitfalls (v1.2 — overlay geometry, IMPORTANT):**
  - `TUI.compositeOverlays()` resets `entry.bounds = undefined` at the start of EVERY
    render pass and calls the component's `render()` INSIDE that pass →
    `overlayHandle.getBounds()` is always undefined/stale during `render()`. Deriving
    the viewport from it makes every frame (a) render full content so `maxHeight` slices
    off the bottom border, and (b) clamp `scrollTop` to 0 every frame (scrolling appears
    broken: panel snaps back to the top). **Never read overlay bounds inside render();
    size the box from `tui.terminal.rows` matching the overlay options exactly**
    (content rows = `floor(rows · 0.88) − 2` for `maxHeight: "88%"`).
  - Wheel events: `TuiAltScreen` parses SGR/X10 wheel in an input listener and
    dispatches `TuiMouseEvent{type:"wheel",wheelDelta}` to `handleMouse()` (always
    consumes; wheel outside overlay bounds falls back to transcript scroll).
    `TuiMainScreen` registers NO input listener and enables NO mouse mode → raw SGR
    wheel strings (`ESC[<64;x;yM` up / `ESC[<65;x;yM` down) pass through to the focused
    component's `handleInput()`. Both paths are implemented; do not enable mouse mode
    out-of-band from the extension (it would leak on crash and fight pi's design).
- **Known Pitfalls (v1.3 — tool dates + two columns):**
  - `createRequire(...).resolve("@earendil-works/pi-coding-agent")` FAILS with
    `No "exports" main defined`: the package's `.` export is **import-only** (no
    `require`/`default` condition). To find the package root, walk node_modules chains
    instead (extension dir → cwd → `process.argv[1]` dirname → `~/.pi/agent/install/
    releases/<ver>` latest-first; sort versions numerically, NOT lexicographically —
    `1.10.0` must beat `1.5.0`).
  - `truncateToWidth` wraps the ellipsis in `\x1b[0m` resets → the RAW string length of
    a truncated line exceeds its visible width. Length assertions must strip ANSI
    (`/\x1b\[[0-9;]*m/g`) before comparing; real terminals are unaffected.
  - Concise arrow `const f = (...): void => arr.push(x)` is a type error (TS2322 —
    `push` returns number); use a block body for `: void` callbacks.
  - `wrapped()` continuation lines must use indentation only (spaces), not the repeated
    label prefix — at half-column widths the repeated `skills`/`extensions` labels
    looked broken.
- **Known Pitfalls (v1.4 — git probe):**
  - Modern git (≥2.31-ish) OUTSIDE a repo prints `warning: Not a git repository.` plus
    a huge usage dump to STDOUT and exits **0** (no `fatal:`). Detect non-repos with
    `/not a git repository/i` over the combined output — not by exit code, not by
    `fatal:`. The usage-dump noise is harmless: `parseNumstat` skips non-matching lines.
  - numstat counts follow git's minimal-edit (Myers) algorithm — expected +/- in tests
    must be verified against REAL git output, not hand-counted (a "drop 3 lines" fixture
    that actually keeps 8 of 10 lines yields `-2`, not `-3`).
  - `xargs ... wc -l` may spawn SEVERAL wc processes (many files) → several `total`
    lines; the parser skips every line whose path is `total`.
  - `session_start` events carry NO cwd — capture the session-start baseline on
    `resources_discover` (fires with cwd at startup/reload, i.e. session start).
  - **Dual module instances in tests:** the jiti-loaded factory and a native
    `import()` of the same stats.ts are SEPARATE module instances with separate
    in-memory state (gitBaseline, caches). Wiring checks must use ONE instance
    (tests: `ext.default`); in production pi loads everything through a single jiti
    runtime, so production is single-instance. (The v1.1 usage store was immune — its
    state lives in a file.)
  - Never let a git probe block the first dashboard frame: render immediately with
    the section pending (`…`), merge the async result into `lastData` and re-render;
    the 2 s TTL cache (key = cwd+baseline, in-flight dedupe) keeps live refreshes from
    re-spawning git.
- **Known Pitfalls (v1.5 — MTP + rating):**
  - LM Studio exposes MTP/speculative counters ONLY inside the completion response
    body's `stats` field (`total_draft_tokens_count`, `accepted_draft_tokens_count`,
    …) — there is NO metrics endpoint (`/metrics`, `/api/v0/server/*` →
    "Unexpected endpoint or method"). `stats` is `{}` for 1-token answers (no draft
    proposals possible) and when speculative decoding is off; the probe must use
    enough `max_tokens` (32) to be meaningful, and treat `total === 0` as "no data".
  - `tool_execution_end.durationMs` is `undefined` when the tool did not actually run
    (e.g. aborted/rejected) — never record 0 ms for those; fall back to the
    start-event wall clock if present, else skip the call entirely.
  - The MTP probe is a REAL completion (costs a few dozen tokens on the local model):
    gate it on `model.provider === "lmstudio"`, 5 s timeout via AbortController, 60 s
    result cache, and never let it reject into the handler (fire-and-forget merge).
- **Known Pitfalls (v1.5.1 — column alignment):**
  - Fixed `padEnd(14)`/`padEnd(18)` first columns break as soon as ONE label exceeds
    the constant (extension basenames like `session-name-border.ts` = 22, MCP tool
    names 30+, section names are arbitrary prompt tags). Compute the width per table
    from the labels actually rendered: `columnWidth(labels, min, gap=2)` — min keeps
    the compact look while everything is short; the longest label gets exactly `gap`
    trailing spaces. Alignment must be tested, not eyeballed: assert that a marker
    string (e.g. `added `, ` runs`, `· `) starts at the SAME index on every row of the
    table.
  - A padded cell that is EXACTLY filled by its content loses its separator:
    `"uses".padEnd(4) + "added"` → `usesadded` (the 3-char singular `use` looked fine,
    hiding the bug — every fixture row happened to be plural). Keep a LITERAL space
    outside the padded cell (`${unit.padEnd(4)} added`).
  - Variable-width value columns shift the columns after them too: `use`/`uses`
    (3 vs 4 chars) and `formatNumber(9)` vs `formatNumber(1500)` (`9` vs `1.5k`).
    Right-align numerics in a fixed cell computed from the row data (`padStart(maxLen)`),
    and put OPTIONAL annotations (e.g. `· avg 2.5s/call` in the perf rating table)
    after the last aligned column, never between them.

## 6. Next Immediate Action
- **DONE:** v1.3 implemented and verified — two-column layout (LEFT stats | RIGHT
  environment), middle divider, tools list from the live prompt, global usage incl.
  tools; v1.2 guarantees hold (bottom border, stable scroll, wheel in both modes).
- **DONE:** v1.4 implemented and verified — changes (this session, git) section in the
  LEFT column; single-spawn git probe (`--no-optional-locks`, 5 s timeout, 2 s TTL
  cache + in-flight dedupe), session-scoped baseline captured on `resources_discover`
  (committed work still counts); 45 unit tests + 4 integration checks (real temp git
  repo), tsc --strict clean, real loader loads all six extensions (0 errors).
- **DONE:** v1.5 implemented and verified — `last turn` performance row (rate of the
  single most recent work item over its own span); MTP acceptance row (live probe of
  LM Studio's completion-response `stats`, provider-gated, 5 s timeout, 60 s cache,
  silently absent on failure/no data — verified live: 88% accepted on
  qwen/qwen3.8-27b); global perf rating 1–5 (new `~/.pi/agent/perf-stats.json`
  duration store fed by `tool_execution_end`, weighted composite 0.5·duration +
  0.3·frequency + 0.2·static, criteria in `PERFORMANCE-RATING.md`, generator
  `perf/rate.mjs` → `perf/perf-ratings.json`, RIGHT-column `perf rating` section).
  53 unit tests + 5 integration checks, tsc --strict clean, real loader 0 errors.
- **DONE (v1.5.1):** table column alignment — every dashboard table (sections,
  context files, roles, performance windows incl. MTP row, usage, perf rating) now
  computes its first-column width from the longest label shown (`columnWidth()`);
  numeric cells fixed-width right-aligned; optional `avg/call` annotation moved after
  the last aligned column. 58 unit tests (5 new alignment tests incl. a
  marker-index-same-on-every-row assertion helper) + 5 integration checks, tsc
  --strict clean.
- **Target (user):** live TUI check of v1.5 + v1.5.1 — **first run `/reload` (or
  restart pi)** so the running process loads the updated extension (the live process
  still records no tool durations until reloaded), then open `/stats` with the
  lmstudio model selected:
  performance section shows the `last turn` row and (after ~1 s) the
  `mtp (lm studio) NN% accepted (x/y drafts)` row; RIGHT column shows `perf rating`
  with 1–5 scores (avg ms/call appears once durations accumulate); `perf/perf-ratings.json`
  regenerable via `node perf/rate.mjs`; and all table columns stay aligned even with
  long names (usage table, perf rating, performance windows).
- **Superseded (v1.4):** live TUI check of v1.4 — open `/stats` in a git project, confirm:
  the `changes (this session, git)` section in the LEFT column shows +added -deleted
  with file count (+ untracked line + top-2 files when present); in a non-repo dir it
  shows `(not a git repo)`; commits made after opening still count (session-scoped
  baseline); section fills in within ~50 ms of the first frame (pending `…`); scroll,
  wheel, bottom border and esc all unchanged.

## 7. Future (not implemented)
- Extension RUN durations (no per-call hooks exist for extensions — rating is
  static+frequency driven for them; could approximate via command-handler timing if
  the instrumentation line wrapped the handler).
- MTP stats for non-lmstudio providers if they ever expose draft counters.
- Per-session context-growth sparkline (needs per-session local state).
- Per-message drill-down; RPC/JSON fallback rendering; image token line.
- Usage trend over time (firstSeen/lastUsed already stored — could render a
  "last used" column once counters accumulate real data).
- New extensions added later need the one-line `trackExtensionRun(import.meta.url)` to
  show non-zero counters (documented in README).
