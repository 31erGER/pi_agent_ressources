# PLAN.md — Active Technical Implementation Plan & State Anchor
> Created: 2026-11-09 17:13 · Baseline: `.pi/baseline/2026-11-09_1713/` · Git: none (parent repo is backup-only per user) · Status: completed · Last verified: 2026-11-09 (step 7: 37/37 green, jina-clean, jiti smoke OK)
> After a compaction or in a new session: read this file and `tail -n 60 .pi/LOG.md` before doing anything else.
> Supersedes: `.pi/archive/PLAN_2026-11-09_1631.md` (completed; verified progress 4/4 steps) — Delta: new task from `.pi/SPEC.md` — six new optional tool parameters (fetch.offset, search.freshness, search.category, search.language, search.page, fetch.raw) implemented TDD.

## 1. Human Requirement (Original Intent)
Implement `.pi/SPEC.md` ("Requestable Parameter Extensions"): give the model more control over the web-tools — read long pages in chunks (`fetch.offset`), get recent results (`search.freshness`), steer result type/language/page (`search.category`, `search.language`, `search.page`), and read raw bodies like JSON APIs (`fetch.raw`). All optional and backward compatible, human-readable config, no proxies, TDD against `test-web.mjs`.

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** `search` builds its SearXNG request with `URLSearchParams` and only appends a query param when its optional argument is set (absent → request byte-identical to today). Optional values are validated against schema + runtime (SearXNG enum/limits, `SEARCH_CATEGORIES`, `SEARCH_PAGE_MAX`) and the applied filters are echoed in `details`. `fetch` converts the FULL text first (existing behavior), then slices `[offset, offset + max_chars)`; a range notice `[showing chars X–Y of Z …]` is appended whenever the returned window is smaller than the page (word "truncated" retained for `start=0` so existing test F4 stays green); `raw: true` skips HTML→text conversion and the content-type gate but still applies offset/truncation.
- **Data / Control Flow:** `LLM tool call -> execute(toolCallId, params, signal) -> validate/optional params -> HTTP GET (SearXNG / direct URL) -> convert (unless raw) -> slice offset window -> { content, details(+total_chars, returned_start, returned_end, has_more / +time_range, categories, language, pageno) } -> pi` (failures: `isError: true`, never throw)
- **Reuse & Conventions:** existing `textResult`/`errorResult`/`clampParam`/`htmlToText` in web.ts; harness `withFetchStub` (records requested URLs → hermetic param assertions) + fixtures (add `PATTERN` 45 000-char plain page + `JSON_DOC`); plain JSON schemas with `enum`/`minimum`/`maximum` (typebox NOT resolvable); config constants at top (add `SEARCH_CATEGORIES` = full 33-category list of this container (verified via `/config`), `SEARCH_PAGE_MAX = 10`)
- **Acceptance Criteria (from SPEC):**
  1. `fetch.offset`: 45 000-char page → chunks 0–20 000 / 20 000–40 000 / 40 000–45 000 with `has_more` true/true/false and correct `total_chars/returned_start/returned_end`; offset beyond end → friendly notice, `isError` falsy; no-offset behavior unchanged (F2/F3/F4 stay green)
  2. `search.freshness`: `week` → request URL contains `time_range=week` + `details.time_range === "week"`; omitted → no `time_range`; invalid value → `isError`
  3. `search.category`: valid → `categories=it` in URL; unknown → `isError`; omitted → not sent; validation source = `SEARCH_CATEGORIES`
  4. `search.language`: set → in URL; omitted or empty string → not sent
  5. `search.page`: `2` → `pageno=2`; `1`/omitted → no `pageno` (identical request to today); `0`/`11` → `isError`
  6. `fetch.raw`: `true` on HTML → markup survives verbatim; `true` on JSON → `JSON.parse` works; still subject to `max_chars`/`offset`
  7. Backward compatibility: all 17 pre-existing tests pass unchanged; full suite green after every step
  8. `promptSnippet`/`promptGuidelines` of both tools document every new knob (checked by new core test C3a/C3b)
  9. `rg 'jina'` stays clean; extension still loads via jiti (pi's production loader)

## 3. Surgical File Map (Strict Scope Boundary)
- `/home/julian/.pi/agent/extensions/web.ts` (Symbol: config block Lines 15–24: add `SEARCH_CATEGORIES` (33 values) + `SEARCH_PAGE_MAX` (10); Symbol: `searchTool.parameters` Lines 96–108: add `freshness` enum, `category` enum, `language`, `page` int 1–`SEARCH_PAGE_MAX`; Symbol: `searchTool.execute` Lines 112–146: runtime validation of optional params, `URLSearchParams` request building (replaces Line 117), echo applied filters in `details`; Symbol: `fetchTool.parameters` Lines 166–180: add `offset` int ≥ 0 + `raw` boolean; Symbol: `fetchTool.execute` Lines 182–227: raw bypass of conversion + content-type gate, offset window slicing with range notice, `details` extended `{total_chars, returned_start, returned_end, has_more}` (keep `truncated`); both `promptGuidelines` blocks: document new knobs)
- `/home/julian/.pi/agent/projects/web-tools/test-web.mjs` (Symbol: fixtures Lines 79–89: add `PATTERN` (45 000-char plain page) + `JSON_DOC`; Symbol: search suite Lines 122–188: add S7–S17 (hermetic URL-capture assertions via `withFetchStub`); Symbol: fetch suite Lines 201–277: add F9–F14 (offset chunks, beyond-end, raw HTML/JSON); Symbol: core suite: add C3a (fetch guidelines mention `offset`/`raw`) + C3b (search guidelines mention `freshness`/`category`/`language`/`page`))
- `/home/julian/.pi/agent/projects/web-tools/.pi/SPEC.md` (Symbol: §4 checklist Lines 66–74: tick each item as its step lands; final line after full regression; header `Status:` → `implemented`)

## 4. Atomic Execution Checklist
> Bookkeeping: the baseline snapshot is the single source of truth; these boxes mirror it for humans. Tick a box only when `diff -u` against the snapshot shows the step's change AND its verification command passed. Then move `(CURRENT)` to the next open step, update section 6 and `Last verified:`, and append a log entry. Every failed attempt goes into `.pi/LOG.md`; lessons for the future also go into section 5. Snapshot note: `web.ts` is snapshotted under its absolute path (`.pi/baseline/<ts>/home/julian/...`) — compare with absolute paths.
- [x] **Step 1:** P0-1 `fetch.offset` — TDD cycle: extend `test-web.mjs` with F9–F12 (chunk boundaries 0/20 000/40 000, `has_more` true/true/false, `total_chars` 45 000, beyond-end notice, no throw) → run RED (log failures) → implement offset in `web.ts` (`offset` param, window slice, range notice, extended `details`) → Verify: `node /home/julian/.pi/agent/projects/web-tools/test-web.mjs` exits 0 (all tests incl. pre-existing F2/F3/F4)
- [x] **Step 2:** P0-2 `search.freshness` — S7 (`time_range=week` in captured URL + `details.time_range`), S8 (omitted → absent), S9 (invalid → `isError`) → RED → implement (schema enum `day|week|month|year` + runtime check + details echo) → Verify: full suite exits 0
- [x] **Step 3:** P1-1 `search.category` — S10 (`categories=it` in URL + details), S11 (unknown → `isError`), S12 (omitted → absent) → RED → implement (`SEARCH_CATEGORIES` config constant with the container's 33 categories + schema enum) → Verify: full suite exits 0
- [x] **Step 4:** P1-2 `search.language` — S13 (set → in URL + details), S14 (omitted/empty → absent) → RED → implement → Verify: full suite exits 0
- [x] **Step 5:** P1-3 `search.page` — S15 (`page:2` → `pageno=2`), S16 (`page:1`/omitted → no `pageno`, URL identical to today), S17 (`0`/`11` → `isError`) + C3b (search guidelines mention all four new knobs) → RED → implement (`SEARCH_PAGE_MAX` config constant, `pageno` only when > 1, search `promptGuidelines` update) → Verify: full suite exits 0
- [x] **Step 6:** P2-1 `fetch.raw` — F13 (`raw:true` on HTML → known tag survives verbatim), F14 (`raw:true` on JSON → `JSON.parse` works) + C3a (fetch guidelines mention `offset`/`raw`) → RED → implement (raw bypass + `fetchTool.promptGuidelines` update) → Verify: full suite exits 0
- [x] **Step 7:** Lock-in — tick SPEC.md §4 checklist (all 8 lines) + `Status: implemented`; regression: full suite, proxy check, production-loader smoke → Verify: `node test-web.mjs && ! rg -n 'jina' /home/julian/.pi/agent/extensions/web.ts && node <jiti smoke from LOG 2026-11-09 16:51>` exits 0

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** other extensions in `~/.pi/agent/extensions/`, pi install dir, SearXNG container, `web.ts.malicious-backup`, the backup-only git repo, archived plans/logs
- **Known Pitfalls / Failed Approaches:**
  - (carried) `@earendil-works/pi-ai` does not resolve from extensions folder — plain JSON schemas only
  - (carried) `execute(toolCallId, params, signal, ...)` — params is the SECOND argument
  - (carried) bare-string results crash pi (`getTextOutput` `.filter` on undefined) — always `{content, details}`, failures via `isError: true`
  - (carried) jiti transpile-only, no local tsc — `test-web.mjs` is the sole runtime gate
  - (carried) SearXNG `results[].title` can be null — guard when mapping
  - (carried) never reintroduce a third-party proxy — `rg 'jina'` check stays in Step 7
  - NEW: `URLSearchParams` encodes spaces as `+` ("social media" → "social+media") — URL-substring assertions in tests must use unambiguous values (e.g. `categories=it`) or the encoded form
  - NEW: backward compatibility is asserted by tests — absent optionals must not add ANY query param; `page: 1` must omit `pageno`
  - NEW: existing F4 pins the old notice contract (text matches `/truncated/i`, `details.truncated === true`) — the new range notice must keep the word "truncated" for `start=0` windows and keep the `truncated` field
  - NEW: snapshot of out-of-root `web.ts` lives under `.pi/baseline/<ts>/home/...` — `cmp` must use the absolute source path, not the CWD-relative one (false "mismatch" otherwise)

## 6. Next Immediate Action
- **Status:** ALL STEPS DONE (7/7). SPEC.md fully implemented and ticked; status `completed`.
- **Future changes:** any new parameter → archive this plan, snapshot, new plan (TDD per SPEC method).
- NEW pitfall (step 3): C2 pins the 5 original config constants to the top 25 lines — insert new config constants AFTER the FETCH_* block, never in the middle
