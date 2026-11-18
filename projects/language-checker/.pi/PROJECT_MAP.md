# PROJECT_MAP.md — language-checker (pi TUI input-field spelling checker)

## Tech Stack
- TypeScript (ESM; loaded by pi via jiti with release aliases; `node --test` with native type-stripping for unit tests)
- pi extension API: `@earendil-works/pi-coding-agent` — `CustomEditor`, `ctx.ui.setEditorComponent` / `getEditorComponent`, `pi.registerCommand`
- pi TUI: `@earendil-works/pi-tui` — `Editor` render pipeline (`render(width): string[]`), `CURSOR_MARKER`, ANSI/SGR styling
- Data: bundled plain-text English word list `en-words.txt` (~104k words, copied from `/usr/share/dict/american-english`). No npm dependencies.

## Core Directories
- `/home/julian/.pi/agent/extensions/language-checker/` — shipped extension (entry `index.ts`, `editor.ts`, `spell.ts`, `highlight.ts`, `en-words.txt`)
- `/home/julian/.pi/agent/projects/language-checker/` — project root (this `.pi/`, unit tests in `test/`)
- `/home/julian/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/` — read-only API truth (`.d.ts` + `docs/`)
- `/home/julian/.pi/agent/bin/pi-ext-loadtest.mjs` — authoritative runtime load test for all user extensions

## Domain-to-Path Mapping
- "input field" / "editor" → pi-tui `Editor` (`dist/components/editor.d.ts`: `getText`, `getLines`, `onChange`, `render`, `invalidate`) + `CustomEditor` (`pi-coding-agent/dist/modes/interactive/components/custom-editor.d.ts`)
- "toggle on/off" → `pi.registerCommand("spelling", ...)` in `extensions/language-checker/index.ts`
- "spelling of english words" → `spell.ts` (dictionary Set + false-positive heuristics) + `en-words.txt`
- "red underline" → `highlight.ts` (SGR-aware re-styling of rendered lines), applied from `editor.ts` `render()` override
- "must not break other extensions" → wrap previous factory from `ctx.ui.getEditorComponent()` (conflict: `session-name-border.ts` also calls `setEditorComponent` in `session_start`)

## Verification Commands
- All unit tests: `node --test /home/julian/.pi/agent/projects/language-checker/test/ 2>&1 | tail -n 5`
- Single test file: `node --test /home/julian/.pi/agent/projects/language-checker/test/spell.test.ts 2>&1 | tail -n 5`
- Runtime load test: `node /home/julian/.pi/agent/bin/pi-ext-loadtest.mjs 2>&1 | tail -n 5` (expect `ALL LOADED`, exit 0)
- Type check: `npx -y -p typescript@5.9.2 tsc -p /home/julian/.pi/agent/projects/language-checker/test/tsconfig.json 2>&1 | tail -n 30` (config created in Step 6; pin `typescript@5.9.2`)
