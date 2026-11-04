# LOG.md — dynamic-readoning-levels (append-only)

### 2026-11-04 15:47 · PLAN
- Plan created in the project folder (PLAN.md, PROJECT_MAP.md, baseline/ — sibling `projects/lmstudio` convention; git repo root is the shared /home/julian/.pi/agent). No previous plan to archive.
- Research (this session): pi-native per-model options confirmed (thinkingLevelMap + live shift+Tab re-derivation, agent-session.js:2156 / pi-ai models.js:694); LM Studio 0.4.28 API does NOT expose per-model reasoning efforts (live probe: /api/v0/models, /api/v0/models/{id}, /v1/models). Per user decision: no polling/watchers — native refresh moments (session start, /model, /lmstudio, /reload) are the cadence; new extension = /efforts TUI command + guarded pi.setModel after native refresh.
- Baseline folder: baseline/2026-11-04_1532/ (empty — all 4 plan files are new). Step 1 (CURRENT): RED unit tests dynamic-efforts.test.mjs.

### 2026-11-04 16:32 · STEP done — Step 1: RED unit tests
- Wrote dynamic-efforts.test.mjs (23 tests: parseLevelsArg 7, applyEffortArray 7, levelsFromModel 4, optionsDiffer 5).
- RED confirmed: node dynamic-efforts.test.mjs → ERR_MODULE_NOT_FOUND dynamic-efforts.ts (module missing, as planned).
- Next: Step 2 — implement dynamic-efforts.ts until green.

### 2026-11-04 16:34 · STEP done — Step 2: dynamic-efforts.ts implemented
- Implemented parseLevelsArg, applyEffortArray, levelsFromModel, optionsDiffer (pure, imports only PI_LEVELS/DEFAULT_ENTRY/types from ../lmstudio/lmstudio-efforts.ts).
- GREEN: node dynamic-efforts.test.mjs → 23/23 pass, 0 fail.
- Next: Step 3 — extension wiring extensions/dynamic-thinking-levels.ts + typecheck.

### 2026-11-04 16:47 · STEP done — Step 4: e2e (RPC + mock server)
- Wrote e2e.mjs: mock LM Studio server (dynamic catalog) + real pi --mode rpc child; JSONL client (req_N ids, response matching).
- Fixes along the way: (1) waitFor must await async predicates; (2) 2nd mock model needed capabilities:["thinking"] — the EXISTING extension's isReasoningModel checks capabilities or id-pattern, "mock-new-model" matched neither → model came up non-reasoning (["off"]); (3) auto-entry expectation must use the real DEFAULT_ENTRY from ../lmstudio/lmstudio-efforts.ts (off none, minimal minimal, low low, medium medium, high high, xhigh xhigh, max xhigh) — my guessed xhigh values were wrong.
- GREEN: ALL E2E CHECKS PASSED (17 checks: baseline 7 levels, /efforts live narrowing AC2, payload reasoning_effort AC3 + clamp into {off,low}, /lmstudio refresh + set_model + auto default entry AC4, on-disk file assertions).
- Re-verified: units 23/23, typecheck 0 errors.

### 2026-11-04 16:47 · STEP in progress — Step 5: manual verification
- DONE (automatable parts): scope guard git status --short → only extensions/dynamic-thinking-levels.ts + projects/dynamic-readoning-levels/ are ours (D APPEND_SYSTEM.md = pre-existing staged change; perf-stats.json = auto-touched; extensions/lmstudio.ts and projects/lmstudio untouched).
- Live smoke on the real server (pi --mode rpc, show-only, no inference): get_state → qwen/qwen3.8-27b reasoning=true, real efforts.json map (high→xhigh); /efforts → "shift+Tab levels: off, minimal, low, medium, high, xhigh, max (file: .../lmstudio/efforts.json)". Extension coexists with the existing lmstudio extension on real 11-model data.
- REMAINING (user, interactive TUI): /efforts off,low,high → shift+Tab cycles exactly that set; next request carries mapped reasoning_effort. See PLAN.md section 6.

### 2026-11-04 16:59 · NOTE — efforts.json semantics (user question: "I only have off,low,medium,xhigh but see max etc.")
- Root cause: user hand-wrote a 4-key entry; the EXISTING extension's ensureModels backfills missing keys from DEFAULT_ENTRY on every refresh (their model load) → entry became 7 non-null keys → all 7 levels visible. Verified in file: qwen/qwen3.8-27b now has minimal:"minimal", high:"high", max:"xhigh" backfilled.
- Fix given to user: /efforts off,low,medium,xhigh in the running TUI (writes explicit nulls + live refresh). Manual alternative: all 7 keys with nulls, then /lmstudio.
- Design note: backfill is deliberate payload safety (openai-completions.js:621 map[level] ?? level — null would send reasoning_effort:null). Changing missing→null semantics = edit of the existing lmstudio project, flagged to user as optional.
