# PROJECT_MAP.md — lmstudio effort project
> Feature project (plan home, tests, e2e, efforts.json): `/home/julian/.pi/agent/projects/lmstudio`
> Host repo: `/home/julian/.pi/agent` (`pi_agent_ressources`) — the wiring file `extensions/lmstudio.ts` lives there for pi auto-discovery.

## Tech Stack
- TypeScript (ESM) extensions, type-stripped at runtime (node 26 / pi's loader) — no build step, no root package.json
- pi runtime 1.5.0: `@earendil-works/pi-coding-agent` (compiled `dist`, READ-ONLY) via `node_modules` symlink
- LM Studio 0.4.28 (OpenAI-compatible, `http://localhost:1234`); tests: built-in `node:test`, no framework
- Verified LM Studio `reasoning_effort` values (live probe 2026-11-04): `none, minimal, low, medium, high, xhigh`
- Pi thinking levels: `off, minimal, low, medium, high, xhigh, max`

## Core Directories
- `extensions/` — global auto-discovered pi extensions (`*.ts`)
- `projects/` — per-feature source folders (audio-notification, stats-dashboard, …; new: `lmstudio/`)
- `skills/` — pi skills (plan, quiet-verifier, …)
- `install/releases/<ver>/` — pi runtime + bundled packages (read-only, never edit)

## Domain-to-Path Mapping
- "LM Studio provider extension" → `extensions/lmstudio.ts`
- "effort config file" → `projects/lmstudio/efforts.json` (created/managed at runtime)
- "effort mapping logic (pure, no pi imports)" → `projects/lmstudio/lmstudio-efforts.ts`
- "effort tests / e2e" → `projects/lmstudio/efforts.test.mjs`, `projects/lmstudio/e2e.mjs`
- "plan / log / baseline" → `projects/lmstudio/PLAN.md`, `projects/lmstudio/LOG.md`, `projects/lmstudio/baseline/`
- "pi openai-completions request builder (reference, read-only)" → `install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/openai-completions-EJNYB6IX.js` (`buildParams`)

## Verification Commands
- All unit tests: `node /home/julian/.pi/agent/projects/lmstudio/efforts.test.mjs`
- E2E (mock server + `pi --print`): `node /home/julian/.pi/agent/projects/lmstudio/e2e.mjs`
- Typecheck (optional, downloads typescript): `npx -y -p typescript tsc --noEmit --strict --skipLibCheck --target esnext --module esnext --moduleResolution bundler --allowImportingTsExtensions /home/julian/.pi/agent/extensions/lmstudio-efforts.ts`
- No lint, no build (runtime type-stripping)
- Real server reachable: `curl -s http://localhost:1234/api/v0/models | jq '.data | length'`
