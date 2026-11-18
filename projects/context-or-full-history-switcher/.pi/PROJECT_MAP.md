# PROJECT_MAP — context-or-full-history-switcher

## Tech Stack
- TypeScript, erasable syntax only (jiti-loaded by pi; Node 26 native type-stripping for tests)
- pi 1.5.2 extension API: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`
- No package-manager dependencies; tests run with built-in `node --test`

## Core Directories
- `.pi/` — this plan, log, snapshots (scoped to this directory, not the git top-level)
- `src/` — pure display logic, no pi imports (directly unit-testable)
- `test/` — `node:test` unit tests for `src/`
- `~/.pi/agent/extensions/history-view.ts` — final extension (per extension-creator skill)
- `~/.pi/agent/projects/context-or-full-history-switcher/` — project root (cwd)

## Domain-to-Path Mapping
- "`full` / `context` view as display lines" → `src/history-view.ts` (`buildHistoryLines(entries, view)`, `formatEntry`, `clampScroll`) — pure, no pi imports
- "`/history` command + popup overlay" → `~/.pi/agent/extensions/history-view.ts` (default-export factory + `HistoryViewer` component, modeled on `stats.ts`' `StatsDashboard`)
- "what the TUI shows vs. what the LLM receives" → pi internals: `buildContextEntries()` (compaction-aware, drives both TUI and model context) vs `getBranch()` (full history); both exposed read-only via `ctx.sessionManager`
- "read-only / as-if-nothing-happened guarantee" → extension performs **zero session writes** (no `appendEntry`/`sendMessage`); popup state is in-memory only, released on `done()`
- "popup conventions to copy (never modify)" → `~/.pi/agent/extensions/stats.ts` lines 1834–2050 (`StatsDashboard`) and 2061–2173 (command + `ctx.ui.custom` overlay)

## Verification Commands
- All unit tests: `node --test test/ 2>&1 | tail -n 15`
- Single test file: `node --test test/history-view.test.ts 2>&1 | tail -n 15`
- Typecheck: `npx -y -p typescript@5.9.2 tsc -p /tmp/ext-tsconfig-histview.json 2>&1 | tail -n 30` (tsconfig maps both pi packages to the 1.5.2 release types; includes the extension + `src/`)
- Runtime load test: `node ~/.pi/agent/bin/pi-ext-loadtest.mjs 2>&1 | tail -n 5` (expect `ALL LOADED`, exit 0)
