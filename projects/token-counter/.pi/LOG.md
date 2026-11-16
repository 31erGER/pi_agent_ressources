# LOG — token-counter project

### 2026-11-16 19:55 · DECISION
- User asked for a more compact/robust way to count GPU tokens. Decision: replace plan A (nuke-time rescue ledger) with plan B (count at generation time).
- Verified in pi source: TurnEndEvent.message.usage (required, +provider/model), SessionCompactEvent.compactionEntry.usage, SessionTreeEvent.summaryEntry?.usage. Only other usage writer = cache warming ("cache_warm", cloud-only, inactive for local models) → excluded on purpose.
- DECISION: ledger = append-only JSONL at ~/.pi/agent/token-ledger.jsonl; one-time mkdir-locked seed scans sessions/ + discarded-sessions/ (recovers previously nuked tokens; safe because seed is one-shot).
- DECISION: nuke-session.ts NOT modified; display toggle decoupled from recording; helper module in extensions/token-counter-ledger/ (subdir without index.ts is skipped by pi discovery — verified in loader.js).

### 2026-11-16 19:55 · PLAN
- Created .pi/PLAN.md (plan B, 4 steps, TDD). Previous plan archived as .pi/archive/PLAN_2026-11-16_0942.md (status: superseded, 0/5 steps done); old log archived as .pi/archive/LOG_2026-11-16_0942.md.
- Snapshot: .pi/baseline/2026-11-16_1951/ (token-counter.ts only — the sole file being modified).
### 2026-11-16 20:31 · STEP 1 · DONE
- test/token-ledger.test.ts written (9 unit + 7 wiring tests, hermetic via PI_CODING_AGENT_DIR mkdtemp).
- node --test test/ → RED, single cause: ERR_MODULE_NOT_FOUND extensions/token-counter-ledger/ledger.ts (as intended, TDD red).
### 2026-11-16 20:32 · STEP 2 · DONE
- extensions/token-counter-ledger/ledger.ts implemented (usageOf/sumSessionFile/sumSessionFiles/appendUsage/sumLedger/seedIfNeeded/ledgerPath).
- node --test: 15 tests, 9 pass (ALL unit), 6 fail = wiring, all ENOENT on token-ledger.jsonl (old extension writes nothing — expected red).
### 2026-11-16 20:34 · STEP 3 · DONE
- extensions/token-counter.ts rewritten: turn_end/session_compact/session_tree append ledger lines (all modes, toggle-decoupled); session_start awaits one-time seed (closes seed/first-turn double-count race); footer reads sumLedger (5s tick + event-triggered, coalesced); /token-counter = display only.
- node --test: 15/15 PASS (9 unit + 6 wiring).
- Import smoke: token-counter + nuke-session both load, default export = function. token-counter-ledger/ contains only ledger.ts (skipped by pi discovery).
- Real-dir dry run (read-only, 51 ms full scan): live sessions 25 files = 167,030,282↑ / 2,728,339↓; previously nuked 10 files = 11,290,682↑ / 270,395↓; seed total = 178,320,964↑ / 2,998,734↓.
