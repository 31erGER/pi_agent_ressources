# PLAN.md — Active Technical Implementation Plan & State Anchor
> Created: 2026-11-16 19:51 · Baseline: `.pi/baseline/2026-11-16_1951/` · Git: none (user: no git in this session) · Status: active · Last verified: 2026-11-16 (steps 1–3 verified: 15/15 tests green, import smoke OK)
> After a compaction or in a new session: read this file and `tail -n 60 .pi/LOG.md` before doing anything else.
> Supersedes: `.pi/archive/PLAN_2026-11-16_0942.md` (superseded; verified progress 0/5 steps) — Delta: architecture changed from "nuke-time rescue ledger" (A) to "count at generation time" (B); `nuke-session.ts` and `deleted-session-tokens.json` are out of scope.

## 1. Human Requirement (Original Intent)
The footer counter must reflect **all tokens that went through the GPU**, for the whole lifetime of the
machine — including sessions that are later nuked, deleted via the built-in /resume UI, or never saved
to disk anymore. The previous design (rescue tokens into a JSON at nuke time) was replaced after
verification showed pi emits the exact usage for every local-model call as an **event at generation
time**, which makes a generation-time ledger both more compact and more robust.

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** Append-only ledger `~/.pi/agent/token-ledger.jsonl` (one JSON line per GPU call,
  appended the moment pi reports the usage). Session files are no longer a data source, so deleting,
  nuking, restoring or resuming sessions cannot affect the counter. One-time **seed** migrates the past:
  sums all existing `sessions/**/*.jsonl` **plus `discarded-sessions/`** (previously nuked sessions —
  safe to include because the seed runs exactly once; there is no later file scan to double-count).
- **Ledger line formats** (all fields except `t` optional; reader skips unparseable lines):
  - turn:      `{"t":"<iso>","m":"<provider>/<model>","i":<input>,"o":<output>}`
  - compaction:`{"t":"<iso>","kind":"compact","i":n,"o":n}`
  - branch:    `{"t":"<iso>","kind":"branch","i":n,"o":n}`
  - seed:      `{"t":"<iso>","seed":true,"i":n,"o":n,"files":<count>}`
- **Data / Control Flow (record):** `turn_end` (`event.message.usage`, +`provider`/`model` from the
  AssistantMessage) / `session_compact` (`event.compactionEntry.usage`) / `session_tree`
  (`event.summaryEntry?.usage`) → `appendUsageLine()` = single `fs.appendFile` (O_APPEND; lines < 200 B
  ⇒ atomic per write(2) on Linux; multi-process safe). All-zero usage lines are skipped.
  Recorder runs in ALL modes (tui + rpc) and is NOT gated by the display toggle.
- **Data / Control Flow (seed):** `session_start` → `seedIfNeeded(agentDir)`: seed line already present?
  skip. Else mkdir-lock `<agentDir>/.token-ledger.lock` (EEXIST: re-check seed line; lock older than 2 min
  ⇒ stale, take it over) → one-shot full scan of `sessions/` + `discarded-sessions/` (same `usageOf`
  semantics as before: assistant `message.usage` + `compaction`/`branch_summary`/`usage` entries) →
  append ONE aggregate seed line → rmdir lock.
- **Data / Control Flow (display):** 5 s tick + `turn_end`/`session_start`/`session_compact`/`session_tree`
  → `sumLedger()` (full re-parse memoized on mtime+size — file stays small: ~1 MB/year; no byte-offset or
  leftover state) → footer `Σ↑{in} Σ↓{out} (global)` (same label/format as today). Toggle command keeps
  its name/behavior for display only.
- **Reuse & Conventions:** `usageOf()`/file-walker/full-file sum are **moved** from the current scanner
  into the helper module (semantics unchanged, so the seed total matches what today's counter shows).
  Helper module lives in `extensions/token-counter-ledger/` — a subdirectory **without** `index.ts`,
  which pi's discovery silently skips (verified in `dist/core/extensions/loader.js` `discoverExtensionsInDir`),
  so it is not loaded as an extension. `getAgentDir()` from `@earendil-works/pi-coding-agent`
  (honors `PI_CODING_AGENT_DIR` — verified in `dist/config.js`) with explicit-dir parameters for tests.
  Agent-dir-root data file matches existing convention (`perf-stats.json`, `usage-stats.json`).
- **Event coverage (verified in `dist/core/extensions/types.d.ts` + `session-manager.js`):**
  `TurnEndEvent.message: AgentMessage` (usage required, +provider/model), `SessionCompactEvent.compactionEntry.usage`,
  `SessionTreeEvent.summaryEntry?.usage`. Only other usage writer in pi core is cache warming
  (`appendUsage("cache_warm")`, cloud providers with prompt caching only — inactive for local models,
  not GPU work) → intentionally not counted.
- **Acceptance Criteria:**
  1. `node --test test/` green: unit (append/sum/seed incl. discarded-sessions, corrupt-line skip, seed idempotency)
     + wiring (fake-pi: the three events append correct lines; session_start seeds once; second start does not re-seed).
  2. First start after the update: footer total ≈ old counter's total **plus** previously nuked sessions
     (seed covers `discarded-sessions/`).
  3. Nuking a session (`/nuke`, `/nuke-exit`) does not change the total — within the process and after restart.
     Built-in /resume-UI deletion likewise.
  4. Tokens generated in non-TUI (rpc) mode are counted.
  5. A torn/corrupt last ledger line is skipped without breaking the total.
  6. pi startup shows no "does not export a valid factory function" error (helper dir is not an extension).
  7. Manual E2E confirmed by the user (see Step 4).

## 3. Surgical File Map (Strict Scope Boundary)
> Baseline note: the target extension file lives **outside** the project root, so `cp --parents` does not
> apply. Snapshot mapping: `token-counter.ts` (baseline) = `/home/julian/.pi/agent/extensions/token-counter.ts`.

- `test/token-ledger.test.ts` (**NEW**, project root `/home/julian/.pi/agent/projects/token-counter/`):
  `node:test` + `node:assert/strict`; hermetic via `PI_CODING_AGENT_DIR=<mkdtemp>` (verified env name) —
  never touches the real agent dir. Two suites:
  - `ledger` (unit, imports `../../../extensions/token-counter-ledger/ledger.ts` with explicit dirs):
    append→sum round-trip; corrupt/partial lines skipped; all-zero input skipped on append;
    `sumLedger` memoization (same mtime+size ⇒ no re-read); `sumSessionFiles` on fixture jsonl
    (assistant usage, user message ignored, compaction, branch_summary, usage entry, line w/o "usage",
    malformed line, last line w/o trailing newline); `seedIfNeeded`: creates exactly one seed line covering
    `sessions/` + `discarded-sessions/`, is idempotent on second call, and creates/cleans the mkdir lock.
  - `wiring` (integration, imports the default export of `../../../extensions/token-counter.ts`, calls the
    factory with a fake `pi` capturing `on`/`registerCommand`): `session_start` seeds the temp agent dir;
    `turn_end` with assistant usage appends a turn line with `m` field; `session_compact` appends compact
    line; `session_tree` appends branch line (and no line when `summaryEntry` is undefined);
    second `session_start` does not re-seed; `session_shutdown` stops the interval (no open handles).
- `/home/julian/.pi/agent/extensions/token-counter-ledger/ledger.ts` (**NEW**, ~180 lines, helper module —
  NOT an extension): `UsageLike`/`Totals` types; `usageOf(entry)` (moved verbatim);
  `findSessionFiles(dir, depth)` + `sumSessionFile(file)` (moved from current scanner, full-file variant);
  `sumSessionFiles(dirs: string[]): Promise<Totals>`; `ledgerPath(agentDir)`;
  `appendUsageLine(line: {...}, agentDir?)` (skips all-zero, single appendFile);
  `sumLedger(agentDir?): Promise<Totals>` (full parse + (mtime,size) memo, corrupt lines skipped);
  `seedIfNeeded(agentDir?): Promise<"seeded"|"already"|"locked">` (mkdir lock, 2-min stale takeover,
  one aggregate seed line, lock cleanup in `finally`).
- `/home/julian/.pi/agent/extensions/token-counter.ts` (**REWRITE**, target ~170 lines, down from 373):
  keep: `formatTokens`, footer status key/text/applyStatus machinery, `/token-counter` toggle (now display
  only), 5 s tick with coalesced rescan, `session_shutdown` cleanup, `trackExtensionRun` import.
  remove: `GlobalUsageScanner` (byte-offset incremental file scanner), deleted-file subtraction,
  local `usageOf`/`Totals`. add: imports from `./token-counter-ledger/ledger.ts`;
  `turn_end`/`session_compact`/`session_tree` handlers append ledger lines (all modes, before the
  `ctx.mode !== "tui"` return); `session_start` calls `seedIfNeeded` then rescans; `statusText` reads
  `sumLedger()`. Header comment rewritten (data source = generation-time ledger + one-time seed).
- **NOT touched:** `nuke-session.ts` (no changes needed in this design), `stats.ts`, any other extension,
  `sessions/`, `discarded-sessions/`, the runtime data file `token-ledger.jsonl` (created at first run).

## 4. Atomic Execution Checklist
> Bookkeeping: the baseline snapshot is the single source of truth; these boxes mirror it for humans. Tick a box only when `diff -u` against the snapshot shows the step's change (or the planned new file exists) AND its verification command passed. Then move `(CURRENT)` to the next open step, update section 6 and `Last verified:`, and append a log entry. Every failed attempt goes into `.pi/LOG.md`; lessons for the future also go into section 5.
- [x] **Step 1:** Write the failing test suite `test/token-ledger.test.ts` (TDD red). Verify: `cd /home/julian/.pi/agent/projects/token-counter && node --test test/ 2>&1 | tail -20` → fails only because `extensions/token-counter-ledger/ledger.ts` is missing and wiring assertions fail (old extension appends nothing).
- [x] **Step 2:** Implement `extensions/token-counter-ledger/ledger.ts` (TDD green). Verify: same `node --test` command → `ledger` suite fully green (wiring suite still red — expected).
- [x] **Step 3:** Rewrite `extensions/token-counter.ts` (event handlers, seed call, `sumLedger`-based footer, display-only toggle, header comment). Verify: `node --test` fully green (incl. wiring) + `diff -u .pi/baseline/2026-11-16_1951/token-counter.ts /home/julian/.pi/agent/extensions/token-counter.ts | head -120` reviewed.
- [ ] **Step 4 (CURRENT):** Manual end-to-end (user, or interactive pi run): restart ALL pi instances → footer total ≈ old total + previously nuked sessions (seed line in `~/.pi/agent/token-ledger.jsonl`); generate usage, `/nuke` → total unchanged; restart → still unchanged; `tail` the ledger shows lines; pi startup shows no extension errors. Verify: user confirms + `jq -c . ~/.pi/agent/token-ledger.jsonl | tail -5`.

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** `nuke-session.ts` (deliberately unchanged), `stats.ts`, other extensions, pi dist, `sessions/`, `discarded-sessions/` contents, the agent-dir git repo (no git this session per user).
- **Do NOT place the ledger helper as a top-level `.ts` in `extensions/`:** pi auto-loads it as an extension and reports "does not export a valid factory function" (loader.js `loadExtension`). It must stay in a subdirectory WITHOUT `index.ts`/`index.js` and WITHOUT a `package.json` `pi` field.
- **Do NOT make the display toggle stop recording** — recording and display are decouposed on purpose (counter-off must not lose GPU tokens).
- **Do NOT add continuous session-file scanning** — the seed is the only file scan; any later scan would reintroduce double-counting with the ledger.
- **Known Pitfalls / Failed Approaches:**
  - Option A (nuke-time rescue ledger, previous plan) was replaced: it needed to modify `nuke-session.ts`, read-modify-write a JSON (multi-process race, corrupt ⇒ reset to 0), and still missed built-in /resume-UI deletions.
  - pi core's `usage` session entries come ONLY from cache warming (`appendUsage("cache_warm")`, session-manager.js) — cloud-only, inactive for local models; intentionally not counted.
  - Old pi processes keep the OLD extension code in memory: during the update window their turns are not appended to the ledger ⇒ **restart all pi instances once after the update** (documented for the user).
  - Deleting the extension file entirely ⇒ tokens generated while absent are lost (no file derivation anymore); hide the footer with `/token-counter` instead.
  - Seed race (two pi starts in the same second on first run): mkdir lock; stale lock (>2 min) is taken over; seed = ONE aggregate line so a crash mid-seed leaves no partial state and the next start retries cleanly.
  - `fs.appendFile` lines must stay < 4096 B to rely on O_APPEND write atomicity (ours are < 200 B).
  - No `tsc` anywhere in the pi install tree and Node 26 only strips types (no type checking) ⇒ rely on `node --test` (unit + fake-pi wiring) and keep the code explicit.
  - `trash`/trash-cli NOT installed here ⇒ nuked files land in `discarded-sessions/` (covered by the seed); on machines with desktop trash, pre-existing trashed sessions are not recoverable (never scanned).

## 6. Next Immediate Action
- **Target File & Symbol:** none (manual E2E by the user) — code complete at step 3.
- **Next Command (user):** restart ALL pi instances, then check footer ≈ `Σ↑178.3M Σ↓3.0M (global)` (seed total measured 2026-11-16), `jq -c . ~/.pi/agent/token-ledger.jsonl | head -1` shows the seed line, run one `/nuke` and confirm the total holds, report back.
