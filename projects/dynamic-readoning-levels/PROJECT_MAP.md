# PROJECT_MAP.md — dynamic reasoning (thinking) levels project
> Project root: `/home/julian/.pi/agent/projects/dynamic-readoning-levels` (pi runs here; the git top-level `/home/julian/.pi/agent` is the shared pi-agent resources repo — plan/log/baseline live in THIS folder, matching the sibling `projects/lmstudio` convention).

## Tech Stack
- TypeScript (ESM) pi extension, type-stripped at runtime (node 26 / pi loader) — no build step, no root package.json
- pi runtime 1.5.0: `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` (compiled `dist`, READ-ONLY) under `install/releases/1.5.0/node_modules/`
- Tests: built-in `node:test` (no framework); e2e drives the real `pi` CLI in RPC mode (`pi --mode rpc --no-session`, JSONL on stdio) against a mock LM Studio server
- LM Studio 0.4.28 (OpenAI-compatible, `http://localhost:1234`); effort config: `projects/lmstudio/efforts.json` (REUSED, auto-managed)

## Core Directories
- `extensions/` — global auto-discovered pi extensions (`*.ts`); new wiring file goes here
- `projects/lmstudio/` — existing efforts module + config + e2e harness (reference; only touched if plan says so)
- `projects/dynamic-readoning-levels/` — this project: pure logic module, tests, e2e, PLAN.md/LOG.md/baseline
- `install/releases/1.5.0/` — pi runtime (read-only, never edit)

## Domain-to-Path Mapping
- "live sync extension" → `extensions/dynamic-thinking-levels.ts` (new)
- "pure effort/option logic" → `projects/dynamic-readoning-levels/dynamic-efforts.ts` (new; no pi imports)
- "existing per-model effort config" → `projects/lmstudio/efforts.json` (reused; `LM_STUDIO_EFFORTS_FILE` override)
- "existing efforts logic (reuse)" → `projects/lmstudio/lmstudio-efforts.ts` (`PI_LEVELS`, `DEFAULT_ENTRY`, `loadEfforts`, `ensureModels`, `entryToThinkingLevelMap`, `effortsFileUrl`)
- "existing LM Studio provider extension (reference, untouched)" → `extensions/lmstudio.ts`
- "pi thinking-level core (reference)" → `install/releases/1.5.0/node_modules/@earendil-works/pi-ai/dist/models.js` (`getSupportedThinkingLevels` L694: null hides a level; xhigh/max need explicit map), `.../pi-coding-agent/dist/core/agent-session.js` (`cycleThinkingLevel` L2156 reads live model; `setModel` L2025 re-clamps; `_refreshCurrentModelFromRegistry` L2749 fires on provider re-register)

## Verification Commands
- Unit tests: `node /home/julian/.pi/agent/projects/dynamic-readoning-levels/dynamic-efforts.test.mjs`
- E2E (mock server + real `pi --mode rpc`): `node /home/julian/.pi/agent/projects/dynamic-readoning-levels/e2e.mjs`
- Typecheck: `npx -y -p typescript tsc --noEmit --strict --skipLibCheck --target esnext --module esnext --moduleResolution bundler --allowImportingTsExtensions /home/julian/.pi/agent/projects/dynamic-readoning-levels/dynamic-efforts.ts /home/julian/.pi/agent/extensions/dynamic-thinking-levels.ts`
- Real server probe: `curl -s http://localhost:1234/api/v0/models | jq '.data | length'`
- No lint, no build (runtime type-stripping)
