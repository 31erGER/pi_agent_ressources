# LOG.md — web-tools (new plan era: SPEC.md parameter extensions)

### 2026-11-09 17:15 · PLAN
- New plan created implementing .pi/SPEC.md (6 optional tool params, TDD); previous plan archived as .pi/archive/PLAN_2026-11-09_1631.md (status: completed, 4/4 verified); old log → .pi/archive/LOG_2026-11-09_1631.md
- Snapshot: .pi/baseline/2026-11-09_1713/ (web.ts under abs path, test-web.mjs, .pi/SPEC.md — all verified identical)
- Recon: SearXNG accepts time_range/categories/language/pageno (HTTP 200 probe); container enables 32 categories (full list will go into SEARCH_CATEGORIES)

### $(date '+%Y-%m-%d %H:%M') · Step 1 (RED)
- test-web.mjs extended: PATTERN fixture (45 000 plain chars) + /pattern route; tests F9-F12 (offset windows 0/20 000/40 000, beyond-end notice)
- RED confirmed: `node test-web.mjs fetch` → 8/12, F9-F12 failing exactly on the new contracts (details.total_chars undefined, no beyond-end notice); F1-F8 still green

### $(date '+%Y-%m-%d %H:%M') · Step 1 (GREEN) + Step 2 (RED→GREEN)
- Step 1 GREEN: web.ts fetch now slices [offset, offset+limit) after full conversion; range notice [showing chars X–Y of Z …], beyond-end notice, details {total_chars, returned_start, returned_end, has_more, truncated}; empty-page notice; backward compat (no notice for start=0 complete pages) → 21/21
- Step 2 RED: S7/S9 failing as expected (no time_range in URL, no validation)
- Step 2 GREEN: web.ts search now uses URLSearchParams (q, format, +time_range only when set); SEARCH_FRESHNESS const + schema enum + runtime validation + details.time_range echo (null when unset) → 24/24, exit 0

### $(date '+%Y-%m-%d %H:%M') · Step 3 (RED→GREEN, with one regression fixed)
- RED: S10/S11 failing as expected (no categories param, no validation)
- Implementing SEARCH_CATEGORIES between SEARCH_SNIPPET_CHARS and FETCH_* broke C2 (config constants must stay in top 25 lines; FETCH_TIMEOUT_MS pushed to line 30) → moved SEARCH_CATEGORIES block to the END of the config block; C2 untouched, 27/27
- web.ts search now validates category against SEARCH_CATEGORIES (32 values from container /config), appends categories=<v> only when set, echoes details.categories

### $(date '+%Y-%m-%d %H:%M') · Step 4 (RED→GREEN) + Step 5 (RED→GREEN)
- Step 4: language=de → language=de in URL + details; omitted/whitespace-only → not sent (S13 RED→GREEN, S14 vacuous pass) → 29/29
- Step 5: SEARCH_PAGE_MAX=10 config (after SEARCH_CATEGORIES block); page validated as integer 1..10 BEFORE fetch (out-of-range → isError, NOT clamped — clampParam would have silently fixed 0/11); pageno appended only when > 1 (S16 asserts byte-identical URL to today); details.pageno null for page 1; search promptGuidelines gained the 4-knob line (C3b) → 33/33

### $(date '+%Y-%m-%d %H:%M') · Step 6 (RED→GREEN) + Step 7 (lock-in) — PLAN COMPLETE
- Step 6: rawMode (params.raw === true) bypasses conversion AND content-type gate; F13/F14b RED→GREEN, F14 contract test, fetch promptGuidelines gained offset/raw line (C3a) → 37/37
- Step 7 regression: full suite 37/37 exit 0; `rg 'jina'` clean (exit 1 = no match); jiti production-loader smoke OK (search, fetch registered)
- SPEC.md: all 8 checklist lines ticked, Status → implemented
- Final test count: 37 (core 5 incl. C3a/C3b, search 16 incl. S7-S17, fetch 16 incl. F9-F14b)

### $(date '+%Y-%m-%d %H:%M') · Full live test (post-reload) + doc correction
- Full test executed: harness 37/37; live tool calls in reloaded session — basic search ✓, page=2 ✓ (different results), language=de ✓ (de.wikipedia first hit), fetch HTML→text ✓, raw JSON 4-chunk offset read 0/2000/4000/6000→6408 with seamless boundaries + "end of page" ✓, all invalid-param paths → clean isError (page 11, freshness 'yesterday', category 'astrology', ftp://) ✓, result shape {content:[{type:'text'}],details} ✓ with details echoing query/count/time_range/categories/language/pageno
- Finding: SearXNG container returns 0 for time_range+categories COMBINED (q=linux: month alone=20, it alone=114, combined=0 — verified via direct curl). Extension forwards params correctly; empty set is backend behavior, reported cleanly as "No SearXNG results"
- Doc correction: recon miscounted container categories as 32 — actual count 33; SEARCH_CATEGORIES array verified set-equal to /config (33/33, no missing/extra); fixed counts in PLAN/SPEC/PROJECT_MAP (this log stays append-only with this correction)

### $(date '+%Y-%m-%d %H:%M') · Retry-on-empty guideline (TDD) + SearXNG root-cause analysis
- TDD: C3c RED (search promptGuidelines missing retry advice) → GREEN (added line: filtered search w/ 0 results → retry with fewer filters, freshness+category can be empty, use news/general) → full suite 38/38
- SearXNG 0-result root cause (verified in container source, SearXNG 2026.11.9+57ff753ad):
  - Engine selection excludes all engines without `time_range_support = True` when time_range is set (per-engine Python declaration, ~50 engines support it: google, bing, startpage, mojeek, brave, hackernews, bing_news, ...)
  - it category: github/stackoverflow/pypi/npm/mdn/docker_hub/crates.io all declare it False; only hackernews supports it but is `disabled: true` in default settings → it+any freshness = empty engine set = 0 results (0 unresponsive corroborates: nothing was queried)
  - news+freshness: only bing_news/swisscows_news class engines (2 unresponsive observed); science: 1 engine; general: works (24 results)
  - limiter.enabled=false on this instance (verified via /config) — no rate-limit risk for agent traffic
- Suggestions prepared for user (NOT applied): settings.yml +hackernews enabled + explicit limiter off; compose 127.0.0.1 bind + pin image 2026.11.9

### $(date '+%Y-%m-%d %H:%M') · SearXNG config recommendations applied + verified (all approved)
- settings.yml: +hackernews enabled (only it-engine with time_range_support), +explicit `limiter: enabled: false`
- docker-compose.yaml: digest-pinned image (guessed tag 2026.11.9 MISSING in registry → pinned by sha256:287af61f... of verified running image v2026.11.9+57ff753ad), port 8080:8080 → 127.0.0.1:8080:8080
- Container recreated via `docker compose up -d`, UP in 1s, version unchanged
- Verification: port LISTEN 127.0.0.1:8080 only ✓; limiter.enabled=false ✓; it+time_range=week: 0 → 30 results (30/30 from hackernews, e.g. real HN stories), it+month: 0 → 30, it (no filter): 114 → 144 (+30 HN)
- Consistency: rewrote C3c guideline line — old "(e.g. it) can yield empty intersection" now false for it (works via hackernews); new wording: freshness covers only a small engine set per category (it=hackernews, news=2), 0 results → broaden category or drop freshness
- Full harness after all changes: 38/38, exit 0
