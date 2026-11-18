# PROJECT_MAP — stats-dashboard

Project root: `/home/julian/.pi/agent/projects/stats-dashboard`
(The git top-level is `~/.pi/agent`; this subdirectory is the project.)

## Entry points
| Path | Role |
|---|---|
| `~/.pi/agent/extensions/stats.ts` | The shipped extension (single file, ~2.3k lines). Exports pure core (stores, parsers, renderers, trackers) + default factory. |
| `~/.pi/agent/extensions/package.json` | `{ "type": "module" }` — makes Node/tsc/jiti agree stats.ts is ESM. Do not remove. |

## This project
| Path | Role |
|---|---|
| `test/stats-core.test.ts` | Unit tests (58 passing, v1.5.1). Node-native TS, asserts + a tiny `t()` runner. |
| `test/stats-integration.test.ts` | Integration checks (5 passing): real session file, real git repo, real LM Studio MTP, loader path. |
| `perf/rate.mjs` | Regenerates `perf/perf-ratings.json` from the global stores. |
| `perf/perf-ratings.json` | Generated rating snapshot (10 items). |
| `PERFORMANCE-RATING.md` | Global 1–5 perf-rating criteria (v1.5). |
| `README.md` | Main overview + version history + pitfalls. |
| `.pi/SPEC.md` | Running spec/checklist per version. |
| `tsconfig.json`, `package.json` | `typecheck` via npx tsc `--strict`; `test` script. |
| `v15-loader-check.mjs` | Loads all extensions through pi's real `discoverAndLoadExtensions`. |

## Sibling extensions (integrated, minimal touch)
`~/.pi/agent/extensions/`:
- **instrumented (self-report today):** `stats.ts`, `notify-on-settle.ts` (per chime), `reload-resources.ts` (per reload), `token-counter.ts` (per /token-counter — BUGGY key), `lmstudio.ts` (per /lmstudio).
- **not counted at all today:** `nuke-session.ts` (/nuke, /nuke-exit), `web-tools.ts` (tools: fetch, search), `confirmation-dialog.ts` (tool_call dialogs), `message-markers.ts` (/markers), `dynamic-thinking-levels.ts` (/efforts), `themes.ts` (/themes), `history-view.ts` (/history, created 2026-11-18), `turn-stats.ts` (purely event-driven).

## Global stores (data, not code)
| Path | Content |
|---|---|
| `~/.pi/agent/usage-stats.json` | `{version, skills, extensions, tools}` → `{count, firstSeen, lastUsed}`. Env override: `PI_STATS_USAGE_FILE`. |
| `~/.pi/agent/perf-stats.json` | `{version, tools}` → `{calls, totalMs, maxMs, firstSeen, lastUsed}`. Env override: `PI_STATS_PERF_FILE`. |

## pi internals relied on (release 1.5.0)
- `AgentSession` (exported from package root) — `prompt()` runs `_tryExecuteExtensionCommand(text)` **before** the `input` event; extension commands emit **no** event on success. Sole instantiation: `createAgentSession()` → `new AgentSession(...)`.
- `pi.getAllTools()` → per tool `{name, description, parameters, ..., sourceInfo}`; `sourceInfo.path` = extension file path for extension tools, `builtin:<name>` / `<inline:...>` for synthetic sources.
- `pi.getCommands()` → **copies** without handlers (name, description, source, sourceInfo).
- `ExtensionEvent` list has no "command" event; `ui_prompt_start/end` = blocking extension dialogs only.
