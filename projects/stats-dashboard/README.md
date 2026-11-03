# /stats — pi session dashboard (v1.2)

Status: **working**. Live at `~/.pi/agent/extensions/stats.ts` (auto-loaded by pi).
Spec/plan: `.pi/SPEC.md` · Tests: `test/` (run `npm test` from this dir).

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
| Loaded resources | context files, skills, prompts, extensions with project/user/path scope — same discovery rules as the core loader (mirrors `reload-resources.ts`); long lists wrap |
| **Usage (global · all sessions)** (v1.1) | every loaded **skill** and **extension** with a **global counter** (persisted across sessions/processes in `~/.pi/agent/usage-stats.json`) and the **date it was introduced** (file birthtime → mtime fallback). Sorted by counter desc |
| **Performance (output tokens/s)** (v1.1) | average generated tokens per second for the **whole session**, **last 10** and **last 100** turns, each with token total + span (`1.2M out / 3h20m (132 turns)`). Single/zero-span windows show `—` |

## Global usage counters (v1.1) — how they work

**Store:** `~/.pi/agent/usage-stats.json` (override for tests: `PI_STATS_USAGE_FILE`).
Shape: `{ version, skills: { <name>: {count, firstSeen, lastUsed} }, extensions: { <absPath>: {...} } }`.
Read-modify-write per event (the file is the single source of truth, so concurrent pi
processes can't diverge); a corrupt file resets to empty instead of crashing.

**What counts (documented semantics):**
- **skill use** = explicit `/skill:name` input (caught by the `input` event before skill
  expansion) **plus** the agent `read`-ing the skill's `SKILL.md` (`tool_execution_start`;
  skill name resolved via `loadSkills()` index, falling back to the skill directory name).
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

## Files

- `~/.pi/agent/extensions/stats.ts` — the extension (single file, pure core exported)
- `~/.pi/agent/projects/stats-dashboard/test/stats-core.test.ts` — 37 unit tests (node-native, no deps)
- `~/.pi/agent/projects/stats-dashboard/test/stats-integration.test.ts` — jiti load + real-session smoke test + global-store + jiti-client self-report checks
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

Verified: 37 unit tests + 3 integration checks pass; `tsc --strict` clean;
`discoverAndLoadExtensions` (pi's real loader) loads **all six** extensions (five now
import `./stats.ts` for the usage counter) with zero errors; the real `/stats` handler
self-reported its execution through `import.meta.url` under jiti; dashboard rendered
against a real session (625 entries / 301 turns at last run).

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
