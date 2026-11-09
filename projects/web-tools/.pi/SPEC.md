# SPEC.md — web-tools: Requestable Parameter Extensions (search / fetch)
> Created: 2026-11-09 · Status: implemented (2026-11-09) · Baseline plan: `.pi/PLAN.md` (completed 2026-11-09)
> Scope: new optional tool parameters for the pi extension `web.ts` (`/home/julian/.pi/agent/extensions/web.ts`).
> Method: TDD — extend `test-web.mjs` with RED assertions first, then implement. Test harness is the only runtime gate (no local tsc, jiti transpile-only).

## 0. Current State (already controllable — reference, no work)
| Tool | Param | Range | Default | Notes |
|---|---|---|---|---|
| `search` | `query` | string, required | — | SearXNG `q` |
| `search` | `max_results` | 1–10 | 5 | maps to client-side slice; limit = `SEARCH_MAX_RESULTS_LIMIT` |
| `fetch` | `url` | http/https, required | — | direct GET, no proxy |
| `fetch` | `max_chars` | 200–20000 | 20000 | truncation of converted text; cap = `FETCH_MAX_CHARS` |

## 1. Proposed Parameters (prioritized)

### P0-1 · `fetch.offset` — chunked reading of long pages (highest value)
- **Why:** pages longer than `FETCH_MAX_CHARS` (20000) are silently cut off with no way to read the rest. Blocks reading long docs/articles in chunks.
- **Param:** `offset: number`, optional, default `0`, min `0`, max `Number.MAX_SAFE_INTEGER` (clamped to `total_chars`).
- **Implementation:** convert the full HTML to text **first** (no early stop), then slice `text.slice(offset, offset + max_chars)`.
- **Output contract:**
  - `details` must carry `{ total_chars, returned_start, returned_end, has_more }` (numbers).
  - Human-readable notice in text: `[showing chars X–Y of Z]` and, when `has_more`, hint: `refetch with offset=<returned_end> for the next chunk`.
  - `offset >= total_chars` → return notice `[offset N is beyond end of page (Z chars)]`, no error.
- **Config additions:** none new (`FETCH_MAX_CHARS` stays the per-chunk cap).
- **AC / tests:**
  1. fetch long page (locally generated, e.g. 45 000 chars) with no offset → first 20 000 chars, `has_more: true`, `total_chars` correct.
  2. same page with `offset=20000` → exactly the next 20 000 chars, `has_more: true`.
  3. `offset=40000` → last 5 000 chars, `has_more: false`.
  4. `offset` beyond end → friendly notice, `isError` falsy, no throw.
  5. existing no-offset short-page behavior unchanged (backward compatible).

### P0-2 · `search.freshness` — time filter
- **Why:** current-version docs vs. stale docs, news queries; today the model has no way to ask for "recent".
- **Param:** `freshness: "day" | "week" | "month" | "year"`, optional, default = unset (no filter).
- **Implementation:** map 1:1 to SearXNG JSON API `time_range=day|week|month|year`; omitted → param not sent.
- **Output contract:** echo the applied filter in `details` (`{ time_range: <value|null> }`) so results are self-describing.
- **AC / tests:**
  1. `freshness: "week"` → outgoing request URL contains `time_range=week` (assert via stubbed fetch capturing the URL — hermetic, no live dependency on result quality).
  2. omitted → no `time_range` in URL.
  3. invalid value (e.g. `"yesterday"`) → rejected via JSON schema enum; if it still reaches execute → `{isError: true}` with clear message, no throw.

### P1-1 · `search.category` — SearXNG category
- **Why:** code/tech questions want `it`, news wants `news`; avoids general-web noise.
- **Param:** `category: string`, optional, default = unset (SearXNG default `general`).
- **Allowed values (SearXNG):** `general, it, science, files, images, videos, music, social media` (comma-separated list if the container enables more; expose a config constant `SEARCH_CATEGORIES` as the source of truth for validation).
- **Implementation:** SearXNG `categories` (single value here; multi-value not needed).
- **AC / tests:** valid value appears in request URL (`categories=it`); unknown value → schema enum error or `{isError: true}`; omitted → not sent.

### P1-2 · `search.language` — result language pinning
- **Why:** SearXNG returns results as-is; user works in German and English and needs control.
- **Param:** `language: string`, optional, default = unset (SearXNG default). Examples: `"de"`, `"en"`, `"de,en"`.
- **Implementation:** SearXNG `language`.
- **AC / tests:** appears in request URL when set; omitted → not sent; empty string treated as omitted.

### P1-3 · `search.page` — result pagination beyond top 10
- **Why:** today only the top 10 of page 1 are reachable; niche queries need page 2+.
- **Param:** `page: integer`, optional, min `1`, max `10` (config `SEARCH_PAGE_MAX`, sane cap), default `1`.
- **Implementation:** SearXNG `pageno=<page>`; combine with existing `max_results` slice *within* that page.
- **AC / tests:** `page: 2` → URL contains `pageno=2`; `page: 0`/`page: 11` → schema error / `{isError: true}`; `page: 1` → `pageno` omitted (identical request to today → backward compatible).

### P2-1 · `fetch.raw` — skip HTML→text conversion
- **Why:** fetching JSON APIs / plain-text endpoints should return the body as-is, not an HTML-stripped approximation.
- **Param:** `raw: boolean`, optional, default `false`.
- **Behavior:** `raw: true` → return body unmodified (still subject to `max_chars` + `offset` from P0-1, and the truncation notice). `raw: false` → current conversion for `text/*`, current passthrough rules otherwise.
- **AC / tests:** `raw: true` on an HTML page returns markup verbatim (assert a known tag survives); `raw: true` on JSON returns parseable JSON when short enough.

### P3 (explicitly out of scope, low value)
- `safesearch` for search (SearXNG container default is sufficient).
- custom HTTP headers / user-agent override for fetch (security surface, no current need).
- multi-category / boolean query operators for search (SearXNG query syntax is user-facing, not model-facing).

## 2. Cross-Cutting Constraints (apply to every item above)
1. **Return shape:** every path returns `{ content: [{ type: "text", text }], details }`; failures use `isError: true` — never throw, never a bare string (pi `getTextOutput` crashes otherwise — see PLAN.md §5).
2. **Schemas:** plain JSON schemas (typebox NOT resolvable from the extensions folder). Add `enum`/`minimum`/`maximum` to the parameter schemas, not just runtime checks.
3. **Config block:** every new tunable (e.g. `SEARCH_CATEGORIES`, `SEARCH_PAGE_MAX`) goes into the human-readable config block at the top of `web.ts` with a one-line comment; all usages reference the constant.
4. **No proxies:** the fetch path stays direct; the `rg 'r\.jina\.ai|jina'` regression check stays green.
5. **Backward compatibility:** all new params optional with defaults that reproduce today's exact request (no new query params sent when a param is absent).
6. **TDD order:** extend `test-web.mjs` first (RED against current `web.ts`), then implement (GREEN). Keep fetch tests hermetic via the recording fetch stub; only use live SearXNG where the plan already does.
7. **Documentation of params:** update each tool's `promptSnippet`/`promptGuidelines` so the model knows the new knobs exist (e.g. "use `offset` to continue reading long pages").

## 3. Suggested Execution Order
1. P0-1 `fetch.offset` (self-contained, no backend dependency)
2. P0-2 `search.freshness` (one backend param, high daily value)
3. P1-1 → P1-2 → P1-3 `search` params (same pattern, batch into one RED/GREEN cycle)
4. P2-1 `fetch.raw`
After each item: tick here, update PLAN.md/LOG.md per project convention, re-run `node test-web.mjs` (full suite).

## 4. Checklist
- [x] P0-1 `fetch.offset` (tests F9–F12)
- [x] P0-2 `search.freshness` (tests S7–S9)
- [x] P1-1 `search.category` (tests S10–S12; `SEARCH_CATEGORIES` = 33 container categories, verified set-equal to `/config`)
- [x] P1-2 `search.language` (tests S13–S14)
- [x] P1-3 `search.page` (tests S15–S17; `SEARCH_PAGE_MAX` = 10)
- [x] P2-1 `fetch.raw` (tests F13, F14, F14b)
- [x] promptGuidelines updated for all new params (checked by C3a/C3b)
- [x] full `node test-web.mjs` green + `rg 'jina'` clean (37/37, 2026-11-09; jiti production-loader smoke OK)
