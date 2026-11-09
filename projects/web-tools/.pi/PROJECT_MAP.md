# PROJECT_MAP.md — web-tools
> Maps human/business terms to technical paths. Target: the pi extension `web.ts` (web search + page fetch via local SearXNG).
> Updated: 2026-11-09 (post SPEC implementation: 6 optional params, 37 tests)

## Tech Stack
- TypeScript (ESM), zero runtime dependencies; loaded by pi 1.5.0 via jiti (transpile only, no type-check)
- pi extension API: `@earendil-works/pi-coding-agent` (resolves from extensions folder; `defineTool` available at runtime)
- `@earendil-works/pi-ai` does NOT resolve from extensions folder → use plain JSON schemas for tool parameters (no typebox imports)
- Search backend: SearXNG docker container `searxng` (searxng/searxng:latest) at `http://localhost:8080`, JSON API: `GET /search?q=...&format=json`
- Node v26 (native TS type stripping); no local `tsc`

## Core Directories
- `/home/julian/.pi/agent/extensions/` — final extension file `web.ts` lives here (pi loads it at startup)
- `/home/julian/.pi/agent/projects/web-tools/` — project root: plan (`.pi/`), test harness, backup
- `/home/julian/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/` — pi docs (`docs/extensions.md`) + examples (`examples/extensions/hello.ts`), read-only reference
- `/home/julian/.pi/agent/crashes.json` — pi crash log (crash evidence)

## Domain-to-Path Mapping (current)
- "web search" → `search` tool in `/home/julian/.pi/agent/extensions/web.ts` — params: `query` (req), `max_results` (1–10, def 5), `freshness` (day/week/month/year → `time_range`), `category` (→ `categories`, validated against `SEARCH_CATEGORIES`), `language` (→ `language`), `page` (1–10 → `pageno`, omitted for 1); applied filters echoed in `details`
- "read a page" → `fetch` tool in `web.ts` — params: `url` (req, http/https, direct), `max_chars` (200–20000, def 20000), `offset` (≥0, chunked reading; range notice + `details {total_chars, returned_start, returned_end, has_more}`), `raw` (true → body unmodified, bypasses conversion + content-type gate)
- "config" → config block at top of `web.ts` (Lines 14–34): `SEARXNG_BASE_URL`, `SEARCH_MAX_RESULTS(_LIMIT)`, `SEARCH_SNIPPET_CHARS`, `FETCH_TIMEOUT_MS`, `FETCH_MAX_CHARS`, `FETCH_MIN_CHARS`, `SEARCH_CATEGORIES` (33 container categories), `SEARCH_PAGE_MAX`
- "tests" → `web-tools/test-web.mjs` (37 tests: core 5, search 16, fetch 16; fetch tests hermetic via recording stub, search S1/S2 live against local SearXNG)
- "original malicious version" → `web-tools/web.ts.malicious-backup` (read-only reference; proxied every URL through `r.jina.ai`, bare-string results, `execute({query})` bug)
- "extension conventions" → `docs/extensions.md` §Custom Tools / Tool Definition; `examples/extensions/hello.ts`

## Verification Commands
- All tests: `node /home/julian/.pi/agent/projects/web-tools/test-web.mjs` (loads web.ts via Node native TS import exactly like the harness does, mocks the pi API, hermetic stubs for fetch + SearXNG where marked; exit 0 = pass; 37/37 as of 2026-11-09)
- Single tool: `node test-web.mjs search` / `node test-web.mjs fetch`
- SearXNG liveness: `curl -s "http://localhost:8080/search?q=test&format=json" | jq '.results | length'`
- Type-check: n/a (no local tsc; jiti does not type-check) — syntax/runtime covered by test-web.mjs
