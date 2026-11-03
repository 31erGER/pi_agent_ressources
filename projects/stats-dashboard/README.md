# /stats — pi session dashboard (v1.5)

Status: **working**. Live at `~/.pi/agent/extensions/stats.ts` (auto-loaded by pi).
Spec/plan: `.pi/SPEC.md` · Tests: `test/` (run `npm test` from this dir).

## Layout (v1.4)

The panel is split **vertically in half** into two meaningful groups (box width is now
`92%` of the terminal; `maxHeight`/scroll/border behavior unchanged):

```
╭─ LEFT: stats ─────────────┬─ RIGHT: environment ────────╮
│ model/session/cwd/status  │ loaded resources             │
│ context window + bar      │ tools (n) — from live prompt │
│ system prompt sections    │ usage (global) skills/ext/tools│
│ messages breakdown        │                              │
│ tokens + changes (git)    │                              │
│ performance               │                              │
╰─ full-width footer hint ──┴──────────────────────────────╯
```

- **LEFT = this session** (live state): everything that changes while you chat.
- **RIGHT = this environment** (stable): what pi loaded + global cross-session usage.
- A middle divider (`┬`/`┴`/`│`) runs through the box border; the footer hint stays
  full-width. No section from the single-column layout was removed — only regrouped.
- **Column alignment** (v1.5.1): every table (system-prompt sections, project-context
  files, message roles, performance windows, usage, perf rating) computes its
  first-column width from the **longest label actually shown** (`columnWidth()`, min
  keeps the compact look while names are short; the longest label gets exactly two
  trailing spaces). Numeric columns (counts, run totals) are fixed-width and
  right-aligned, so long names — e.g. `session-name-border.ts` or MCP tools like
  `mcp__context7__resolve-library-id` — can never push a row's other columns out of
  line. The performance table's label column even widens to include the
  `mtp (lm studio)` label when the MTP row is shown, and the MTP row reuses the same
  rate/`·` cells as the tok/s rows.
- **Changes (this session, git)** (new, v1.4, LEFT): added/deleted lines since the
  session started — see the *Changes section* below.
- **last turn + MTP** (new, v1.5, LEFT): the performance section gains a
  **`last turn`** row (rate of the single most recent work item: its output tokens
  over the time since the previous item) and, when the current model is served by
  **LM Studio**, an **`mtp (lm studio) NN% accepted (x/y drafts)`** row from a tiny
  live probe — see *Performance section* and *MTP row* below.
- **perf rating** (new, v1.5, RIGHT): every loaded extension and tool rated **1–5**
  (1 = cheap, 5 = costly) from measured data — see *Performance rating* below.
- **Tools** (new, v1.3): the loaded tool list is parsed from the **final system
  prompt's** `<tools>` section (so it reflects exactly what the model sees, including
  dynamic/MCP tools), and every `tool_execution_start` increments a **global tool
  counter** in the same store as skills/extensions, with an introduced date
  (built-in tools: date of `dist/core/tools/<name>.js`; anything else: the pi package
  date). Counting semantics: one `tool_execution_start` = one run, mirroring the
  skill/extension counters (a `read` of a `SKILL.md` counts as both a tool run *and*
  a skill use).

## What it is

`/stats` opens a **boxed, scrollable overlay dashboard** — it does NOT append to the
chat flow and persists nothing to the session. It works **while the agent is running**
(extension commands execute immediately, even mid-stream) and **refreshes live** from
message/turn/agent/session events (throttled to 250 ms).

Keys: `esc`/`q` close · `↑`/`↓`/`pgup`/`pgdn` scroll · **mouse wheel** scroll · `r` force refresh.

## Scrolling & wheel (v1.2)

Two layout bugs fixed in v1.2 (reported: bottom border missing, panel impossible to
scroll to the bottom / performance section unreachable):

1. **Bounds staleness.** pi-tui's `compositeOverlays` resets `entry.bounds` to
   `undefined` at the start of *every* render pass, then calls the component's
   `render()` inside that pass — so `overlayHandle.getBounds()` is always stale
   (undefined) during render. The old code derived the viewport from it, which made
   every frame render full content (the overlay's `maxHeight: "88%"` then sliced off
   the **bottom border**) and clamped `scrollTop` back to **0 on every frame**
   (scrolling appeared broken: the panel snapped back to the top).
2. **Fix:** the box size is computed from the terminal rows, matching the overlay
   options exactly — `content rows = floor(rows · 0.88) − 2` (the two border rows),
   i.e. the component emits exactly the `maxHeight` number of lines, never more.
   The bottom border is always drawn and `scrollTop` survives re-renders.

**Mouse wheel** (v1.2), two code paths covering both TUI modes:
- **Fullscreen/alt mode** (`TuiAltScreen`): pi-tui parses SGR/X10 wheel sequences and
  dispatches a `TuiMouseEvent { type: "wheel", wheelDelta }` to the overlay — the
  dashboard implements `handleMouse()` and scrolls by `wheelDelta` (shift-wheel
  triple speed comes from pi's `WheelScrollAccelerator`). Wheel over the *chat*
  (outside the overlay bounds) still scrolls the transcript.
- **Regular mode** (`TuiMainScreen`): no mouse mode is enabled (by design), so if the
  terminal forwards raw SGR sequences they pass through to `handleInput()` — the
  dashboard recognizes `ESC[<64;x;yM` (wheel up) / `ESC[<65;x;yM` (wheel down)
  and scrolls ±1 line. Keyboard scrolling works in both modes as the universal fallback.

## What is visible (v1)

| Section | Data |
|---|---|
| Header | model + thinking level, session name (ANSI-stripped) + id, cwd, status (`streaming`/`idle` + queued messages) |
| Context window | used / window / % with a 30-col bar (green <50%, yellow <80%, red ≥80%), split into **system prompt** vs **messages** share. Falls back to `calculateContextTokens(lastAssistantUsage)` when live usage is absent |
| System prompt sections | per-section token estimates of the **final prompt** (preamble, tools, rules, docs, addendum, project_context incl. per-file sizes, skills with loaded count, cwd, any custom sections; untagged custom/forced prompts show as one `custom prompt` entry). Estimates use pi's own `estimateTokens` (chars/4, labeled `~`) |
| Messages | count of messages actually in the model context (`buildSessionContext` projection) with per-role counts + token estimates (assistant, user, toolResult, compactionSummary, …) |
| Tokens (session) | session-wide input / output / cache read / cache write / cost / turns (same semantics as pi's footer: assistant usage + compaction + branch summaries), plus the **last turn** (↑in ↓out ↺cacheRead · thinking) |
| **Changes (this session, git)** (v1.4) | **added/deleted lines** in the cwd since the session started, **code and text combined** (all files, one ± pair): `  +123  -45  · 7 files`, plus `  +89 untracked (3 files)` when untracked files exist, plus `  top: a.ts +60 -10 · b.md +30` (the 2 largest files). States: `…` while the probe runs, `(not a git repo)`, `(git unavailable: reason)`. **LEFT column** |
| Loaded resources | context files, skills, prompts, extensions with project/user/path scope — same discovery rules as the core loader (mirrors `reload-resources.ts`); long lists wrap. **RIGHT column** |
| **Tools (n)** (v1.3) | tool names parsed from the final system prompt's `<tools>` section (incl. dynamic/MCP tools). **RIGHT column** |
| **Usage (global · all sessions)** (v1.1, tools in v1.3) | every loaded **skill**, **extension** and **tool** with a **global counter** (persisted across sessions/processes in `~/.pi/agent/usage-stats.json`) and the **date it was introduced** (skill/extension: file birthtime → mtime fallback; tool: see Layout). Sorted by counter desc. **RIGHT column** |
| **Performance (output tokens/s)** (v1.1, last turn in v1.5) | average generated tokens per second for the **whole session**, **last 10**, **last 100** turns and the **single last turn** (its own output over the time since the previous item), each with token total + span (`1.2M out / 3h20m (132 turns)`). Zero-span/insufficient windows show `—`. Below them, when on LM Studio: `mtp (lm studio) 88% accepted (21/24 drafts)` (v1.5) |
| **Perf rating (1 cheap · 5 costly)** (v1.5) | every loaded **extension and tool** rated 1–5 from measured data (duration, global run frequency, static source size/subscriptions); rows `name  N [· avg/call] · M runs`, sorted by rating desc. Criteria: `PERFORMANCE-RATING.md`. **RIGHT column** |

## Changes section (v1.4) — semantics & efficiency

**What it measures:** lines added/deleted in the session cwd **since the session
started** (the baseline is the repo HEAD captured on `resources_discover` at
startup/reload). Code and text are intentionally **combined** — `git diff --numstat`
counts lines, so a markdown change counts the same as a code change (binary files
show as `-` and contribute nothing). **Commits made during the session still
count**, because the diff is baseline→working-tree, not HEAD→working-tree.
Untracked files (respecting `.gitignore`) are counted separately via
`git ls-files --others --exclude-standard | wc -l` and shown as an extra `+N
untracked (n files)` line.

**How it stays cheap (the "most efficient way"):**
- **One shell spawn per probe** — tracked diff and untracked line-count run in a
  single `sh -c` script (the marker `--UNTRACKED--` splits the output).
- `--no-optional-locks` — the probe never blocks git operations pi (or you) do.
- **5 s timeout**, 100 KB buffer cap; failures show `(git unavailable: reason)`
  without touching the rest of the dashboard.
- **2 s TTL cache** (key = cwd + baseline) + **in-flight dedupe** — live refreshes
  and repeated `/stats` opens don't re-spawn git while you look at the panel.
- **Non-blocking:** the dashboard renders immediately with the section pending
  (`…`); when git answers (~10–50 ms) the result is merged in and one re-render
  happens. Nothing waits on git, so `/stats` stays instant even on huge repos.

## Global usage counters (v1.1) — how they work

**Store:** `~/.pi/agent/usage-stats.json` (override for tests: `PI_STATS_USAGE_FILE`).
Shape: `{ version, skills: { <name>: {count, firstSeen, lastUsed} }, extensions: { <absPath>: {...} }, tools: { <toolName>: {...} } }`.
Old store files without `tools` load fine (migrated to `{}` on read).
Read-modify-write per event (the file is the single source of truth, so concurrent pi
processes can't diverge); a corrupt file resets to empty instead of crashing.

**What counts (documented semantics):**
- **skill use** = explicit `/skill:name` input (caught by the `input` event before skill
  expansion) **plus** the agent `read`-ing the skill's `SKILL.md` (`tool_execution_start`;
  skill name resolved via `loadSkills()` index, falling back to the skill directory name).
- **tool run** (v1.3) = every `tool_execution_start` (any tool, incl. dynamic/MCP).
  No filtering: the counter answers "how often does pi actually execute each tool",
  globally across all sessions.
- **extension run** = a self-report. Extension commands are **invisible** to global
  listeners (`AgentSession.prompt()` executes them *before* the `input` event fires and
  records nothing in the session), so each extension carries one line in its
  command/main-action handler: `trackExtensionRun(import.meta.url)` (imported from
  `./stats.ts`, which is why the helpers live in stats.ts — a standalone helper file in
  `extensions/` would fail pi's loader, which rejects modules without a function default
  export).

**Instrumented siblings (one import + one call each, nothing else touched):**
- `lmstudio.ts` — per `/lmstudio` invocation
- `token-counter.ts` — per `/token-counter` invocation
- `notify-on-settle.ts` — per chime (non-aborted `agent_settled`)
- `session-name-border.ts` — per session start (TUI mode)
- `reload-resources.ts` — per `/reload` re-print
- `stats.ts` — per `/stats` invocation (self-reported in its own handler)

## Performance section (v1.1) — definition

Work items = session entries that generated tokens: assistant messages + compaction +
branch_summary entries that carry `usage` (their `SessionEntryBase` ISO timestamp). The
`usage` summary entries are rollups and are **excluded** (double-count). Generated
tokens = `usage.output` (it already includes reasoning tokens — never add
`usage.reasoning`). Rate = Σoutput / span(first→last item) per window; `<2` items or
zero span → `—`.

**Last turn (v1.5):** the most recent work item's rate over its own span
(`out(last) / (at(last) − at(prev))`) — how the model was performing on the very last
message. `<2` items or zero span → `—`.

**MTP row (v1.5):** LM Studio exposes speculative-decoding (MTP) counters only inside
the completion response's `stats` object (no metrics endpoint). When the current
model's provider is `lmstudio`, opening `/stats` fires one tiny chat completion
(`max_tokens: 32`, temperature 0, 5 s timeout, **60 s result cache**) and renders
`mtp (lm studio) NN% accepted (x/y drafts)` when the response reports draft traffic
(`total_draft_tokens_count > 0`). Server down / no stats / any failure → the row is
simply absent (the probe never blocks the panel or throws). Base URL:
`$LM_STUDIO_BASE_URL`, default `http://localhost:1234`.

## Performance rating (v1.5) — 1 cheap … 5 costly

A global, **measurement-driven** impact score for every loaded extension and tool:

```
rating = clamp(1, 5, round(0.5·duration + 0.3·frequency + 0.2·static))
```

- **duration** — measured avg ms/call from `~/.pi/agent/perf-stats.json` (fed by
  `tool_execution_end.durationMs`, wall-clock fallback, invalid values skipped). Bands:
  <50ms / <200ms / <1s / <10s / ≥10s; no data → 1.
- **frequency** — global run count from `usage-stats.json`. Bands: <10 / <100 / <1k /
  <10k / ≥10k runs.
- **static** — implementation size (tool: `dist/core/tools/<name>.js`; extension: the
  source file). Bands: <2KB / <8KB / <32KB (or unknown) / <102KB / ≥102KB. For
  extensions: `max(size, subscription-band)` (`pi.on(` count: 0–1 / 2–3 / 4–5 / 6–9 /
  ≥10) **+1 if the extension renders per TUI frame** (`ui.custom` / `showOverlay` /
  `registerComponent` in source).

Visible live in the dashboard's RIGHT column (`perf rating`), and as the file
deliverable `perf/perf-ratings.json` — regenerate any time with
`node perf/rate.mjs` (same `rateItem()` implementation, so file and panel can never
disagree). Full criteria + limitations: **`PERFORMANCE-RATING.md`**.

Note: durations accumulate from the first tool call *after* the extension was (re)loaded
with v1.5 — until then tool rows show run counts only and average 1 on duration.

## Files

- `~/.pi/agent/extensions/stats.ts` — the extension (single file, pure core exported)
- `~/.pi/agent/projects/stats-dashboard/test/stats-core.test.ts` — 58 unit tests (node-native, no deps)
- `~/.pi/agent/projects/stats-dashboard/test/stats-integration.test.ts` — jiti load + real-session smoke test + global-store + jiti-client self-report + git probe + MTP probe checks
- `~/.pi/agent/projects/stats-dashboard/PERFORMANCE-RATING.md` — v1.5 rating criteria (bands, weights, data sources, limitations)
- `~/.pi/agent/projects/stats-dashboard/perf/rate.mjs` — v1.5 generator: reads both global stores → `perf/perf-ratings.json` + printed table
- `~/.pi/agent/projects/stats-dashboard/perf/perf-ratings.json` — generated ratings (regenerate: `node perf/rate.mjs`)
- `~/.pi/agent/projects/stats-dashboard/.pi/SPEC.md` — spec, guardrails, known pitfalls, future ideas
- `~/.pi/agent/extensions/package.json` — `{"type":"module"}` so Node/tsc/jiti agree on ESM (pi's loader ignores it; other extensions use pure ESM syntax)

Test setup note: `~/.pi/agent/node_modules/@earendil-works/*` are symlinks to the
installed pi packages (needed for bare imports from this project dir). `@types/node`
is symlinked too, for `tsc`.

## How it's verified

```bash
cd ~/.pi/agent/projects/stats-dashboard
npm test                 # unit + integration
node /home/julian/.npm/_npx/a322a253dbd59f36/node_modules/typescript/bin/tsc -p tsconfig.json
```

Verified: **58 unit tests + 5 integration checks** pass (incl. a real temp git repo:
session-scoped counts, committed-work-still-counts, not-a-repo, TTL-cache identity,
resources_discover baseline capture; and the **live MTP probe** against the running LM
Studio: 88% accepted on qwen/qwen3.8-27b, cache identity verified); `tsc --strict`
clean; `discoverAndLoadExtensions` (pi's real loader) loads **all six** extensions
(five now import `./stats.ts` for the usage counter) with zero errors; the real
`/stats` handler self-reported its execution through `import.meta.url` under jiti;
dashboard rendered against a real session (1138 entries / 556 turns at last run) in the
two-column layout (LEFT session | RIGHT environment, middle divider, tools + global
usage + perf rating).

v1.2 verification: end-to-end harness driving the **real** `TuiMainScreen`/`TuiAltScreen`
proved (a) first frame shows the bottom border, (b) keyboard scroll position survives
re-renders, (c) wheel events scroll via `handleMouse` in alt mode and via the raw SGR
passthrough in regular mode.

## Not done / next (see SPEC.md "Future")

- No persistent per-session history of context growth (snapshot only)
- Per-message drill-down (click-to-jump would need TUI selection state)
- No RPC/JSON fallback rendering (those modes notify instead of opening the overlay)
- Usage trend over time (`firstSeen`/`lastUsed` are already stored — a "last used"
  column or sparkline is the obvious next step)
- Counters only cover the six auto-loaded extensions (anything added later needs the
  one-line `trackExtensionRun` to appear non-zero)
