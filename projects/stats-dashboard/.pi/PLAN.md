# PLAN — /stats v1.6: robust global counters + "last used" column

Date: 2026-11-18 · Status: IMPLEMENTED + VERIFIED (Q1: date+time ✓, Q2: passive extensions stay at 0 ✓)
- 65 unit tests + 6 integration checks green; tsc --strict clean
- v16-loader-check.mjs: production identity proven (all 15 real extensions load, 0 errors,
  tracker installed on the NATIVE AgentSession.prototype)
- Sibling edits: confirmation-dialog +1 line (dialog self-report); token-counter/lmstudio
  command self-reports removed; nothing else touched (history-view / turn-stats untouched)
Project: `/home/julian/.pi/agent/projects/stats-dashboard` · Extension: `~/.pi/agent/extensions/stats.ts`

## Problem & goals

User report: several global counters in the `/stats` usage section are not working:

1. **`nuke-session` not counted** — the user runs `/nuke` / `/nuke-exit`, counter stays 0.
2. **`web-tools` not counted** — the agent executes its `fetch`/`search` tools, counter stays 0.
3. **Confirmation dialogs not counted** — `confirmation-dialog.ts` triggers its dialog
   (on `tool_call`), counter stays 0.
4. Positives to preserve: `fetch` + `search` **tool** counters work (v1.3 tool counting).
5. **Verify** the skill and extension counter paths end-to-end.
6. **New column**: in the usage table, add a "last used" timestamp column right after the
   existing "added" (introduced date) column.

### Root cause (recon-confirmed, 2026-11-18)

- Extension counters only increment via a **per-file one-line self-report**
  (`trackExtensionRun(import.meta.url)`). 7 of 13 current extensions never got the line —
  they are new (Nov 4–18) and were created after the convention existed. Per-file
  instrumentation is not robust: every future extension silently stays at 0.
- pi (1.5.0) provides **no global event** for extension command execution:
  - `AgentSession.prompt()` runs `_tryExecuteExtensionCommand(text)` and returns **before**
    the `input` event fires → the `input` handler cannot see extension commands.
  - No `command`/`extension_command` event exists in `ExtensionEvent`.
  - `ui_prompt_start/end` = blocking extension dialogs only, and carry no extension identity.
  - `pi.getCommands()` returns **copies without handlers** → in-place handler wrapping via the
    public API is impossible.
  - **Viable global hook:** `AgentSession` is exported from the package root and
    `_tryExecuteExtensionCommand` is on its prototype (sole instantiation path:
    `createAgentSession()` → `new AgentSession(...)`). Patching the prototype once intercepts
    every extension command in the TUI and any SDK flow.
- **Tool→extension attribution is possible:** `pi.getAllTools()` returns `sourceInfo.path` per
  tool — the registering extension's file path for extension tools, `builtin:<name>` /
  `<inline:...>` for synthetic sources. Counting tool executions against the owning extension
  fixes `web-tools` (agent runs `fetch`/`search` → web-tools counter rises).
- Latent bug found: `token-counter.ts` self-reports with the **bare name**
  `trackExtensionRun("token-counter")` → key becomes `path.resolve(cwd, "token-counter")`,
  which never matches the usage table's file-path key → its command runs were never counted.

### Goals (v1.6)

G1. **Global extension-command counting** without touching each extension: one idempotent
    prototype patch in `stats.ts` that records every successfully handled extension command
    under the registering extension's file path.
G2. **Global tool→extension attribution**: every `tool_execution_start` also increments the
    counter of the extension that registered the tool (when resolvable and a real file).
G3. **Event-driven extensions keep the one-line convention** (no command exists to count):
    add the line to `confirmation-dialog.ts` (user-named); keep existing lines in
    `notify-on-settle.ts` and `reload-resources.ts`.
G4. **De-duplicate**: remove the now-redundant command-handler self-reports in `stats.ts`,
    `token-counter.ts` (also fixes its buggy key), `lmstudio.ts`.
G5. **Skill counters verified** end-to-end (input `/skill:name` + `SKILL.md` read paths hit
    the store), covered by tests.
G6. **"last used" column** in the usage table, directly after "added" (USER DECISION:
    date **and** time): `name  N runs  added 2026-11-01  last 2026-11-02 14:05`.
    UTC, fixed 16-char width (`DD.MM.YYYY HH:MM`), `?` when unknown. Store already
    persists `lastUsed` — no schema change. It is the LAST column of the table, so its
    variable `?` fallback cannot shift any other column (v1.5.1 rule).
G7. All counters stay crash-proof (never break the counted action), persistent across
    sessions (existing `UsageStore`), display-only (zero transcript trace).
G8. (USER DECISION, Q2) Always-on event-driven extensions without a discrete run
    (`turn-stats.ts`) stay at `0 runs` — no self-report: most robust (no coupling between
    extensions) and most performant (no per-settle read-modify-write of the global store).

### Non-goals

- No new store schema (`lastUsed` already exists in `UsageRecord`).
- No counting of passive, always-on extension behavior (e.g. `turn-stats.ts` rendering every
  turn) — only discrete events: command runs, tool runs, dialog shows, chimes, reloads.
- No changes to perf ratings, layout groups, git section, or MTP behavior.
- No changes to pi itself.

## Key design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Prototype-patch `AgentSession.prototype._tryExecuteExtensionCommand` (guarded, idempotent) | Only viable global hook (see negative knowledge below). Degrades gracefully if pi renames the method (install returns `false`, counters for commands simply don't increment; integration test fails loudly). |
| D2 | Wrapper reads `this._extensionRunner.getCommand(name)?.sourceInfo?.path` for attribution | pi's own data → exact extension file path; synthetic paths (`builtin:*`, `<...>`) skipped. |
| D3 | Tool→extension attribution via `pi.getAllTools()` (lazy cache, rebuilt on miss / `resources_discover` / `session_start`) | Covers tools registered later (MCP, `/reload`); `sourceInfo.path` distinguishes extension tools from built-ins. |
| D4 | Key normalization: `resolveUsageKey` additionally applies `realpathSync` (fallback: literal) | All counter sources (import.meta.url, sourceInfo.path, wrapper) and the table lookup (`e.resolved`) then agree on one canonical path; no-op in symlink-free layouts. |
| D5 | Keep self-report only for event-driven extensions (chime, reload, dialog show) | Command runs are now counted globally; double-counting avoided by removing command-handler self-reports. |
| D6 | `last` column `DD.MM.YYYY HH:MM` UTC (new `formatDateTime`), `?` fallback | User asked for date+time; it is the last column, so the variable `?` width cannot break alignment; new formatter reuses the UTC logic of `formatAddedDate` and is NaN/`<=0`-safe. |
| D7 | No self-report for passive always-on extensions (Q2) | Robustness (no cross-extension coupling) + performance (no per-turn store write). Counters only measure discrete, user-visible runs: commands, tool calls, dialogs, chimes, reloads. |

## Negative knowledge (verified dead ends — do NOT retry)

- ❌ `pi.getCommands()` in-place handler wrapping → returns **copies** without handlers
  (`agent-session.js` `_bindExtensionCore.getCommands`).
- ❌ Counting extension commands from the `input` event → commands short-circuit in
  `prompt()` **before** `_runInputHandlers`.
- ❌ Any dedicated event → full `ExtensionEvent` union inspected: no command event.
- ❌ `ui_prompt_start/end` → blocking extension dialogs only; no extension identity field.
- ❌ Reaching the shared command registry from an extension API → per-extension
  `extension.commands` Maps are internal to the loader; runner internals not exposed.
- ❌ Counting `confirmation-dialog` from a global event → it triggers on `tool_call` with its
  own internal conditions; only the extension itself knows when a dialog actually shows.

## Phases

### Phase 0 — Setup (this file + PROJECT_MAP)
- [x] `rg --files | head -50` + outline + sibling audit
- [x] Root cause confirmed against pi 1.5.0 source
- [x] `.pi/PROJECT_MAP.md`, `.pi/PLAN.md`

### Phase 1 — RED: failing tests first [DONE]
File: `test/stats-core.test.ts` (+ factory-level tests in the existing fake-`pi` pattern;
`PI_STATS_USAGE_FILE`/`PI_STATS_PERF_FILE` temp isolation as in existing tests).
- [ ] 1.1 `installExtensionCommandTracker(proto owner class, track)`:
      - handled command → `track` called exactly once with the extension path
      - unhandled (`false`) → not called
      - original throws → rejection preserved, `track` not called
      - `sourceInfo.path` synthetic (`builtin:x`, `<inline:y>`) → not called
      - `this._extensionRunner` missing → not called, no throw
- [ ] 1.2 idempotency: second install is a no-op (one run → one `track` call, not two);
      returns `false` when the prototype lacks `_tryExecuteExtensionCommand`
- [ ] 1.3 `toolOwnerFromList(tools)`: extension path → mapped; `builtin:read` → null;
      `<inline:x>` → null; missing/empty sourceInfo → null
- [ ] 1.4 factory wiring: fake `pi.getAllTools()` → one extension-owned tool (temp file that
      exists on disk); emit `tool_execution_start` → temp usage store has
      `tools[fetch].count === 1` **and** `extensions[<ownerPath>].count === 1`
- [ ] 1.5 `formatDateTime`: `DD.MM.YYYY HH:MM` UTC; null/NaN/`<=0` → null
- [ ] 1.6 `buildStatsColumns` usage block: rows render ` added <date>  last <date> <time>`;
      item with unknown last → ` last ?`; alignment marker `last ` at identical index on all
      rows (long + short names)
- [ ] 1.7 (renumbered from 1.6) `resolveUsageKey`
- [ ] 1.7 `resolveUsageKey`: symlinked temp file → realpath; nonexistent path → literal
      (no throw); `file://` URL still supported
- [ ] 1.8 skill counters end-to-end (if not already covered): factory emits `input`
      `/skill:plan` → store `skills.plan.count === 1`; then `tool_execution_start` for
      `read` of the plan `SKILL.md` path → count 2

### Phase 2 — GREEN: implement in `~/.pi/agent/extensions/stats.ts` [DONE — extra pitfall:
a line-break between `?` and `.` is a SyntaxError (ternary parse) in both tsc and Node
type-stripping; count synchronously (command registered ⟺ handled) so the sync test
runner works and the wrapper returns the original promise untouched]
- [ ] 2.1 Import `AgentSession` (value import, existing bare specifier); export
      `installExtensionCommandTracker(track): boolean` per D1/D2; wrap original, `.then`
      counting, swallow all errors, preserve return value/rejection
- [ ] 2.2 Export `toolOwnerFromList(...)` per D3 (pure); factory keeps lazy
      `Map<toolName, string|null>` cache, invalidated on miss / `resources_discover` /
      `session_start`
- [ ] 2.3 `tool_execution_start` handler: after `trackToolUse`, resolve owner →
      `existsSync` guard → `trackExtensionRun(ownerPath)` (try/catch, never break execution)
- [ ] 2.4 `resolveUsageKey`: realpath normalization per D4
- [ ] 2.5 `UsageItem.last?: string`; new `formatDateTime(ms): string | null` (UTC
      `DD.MM.YYYY HH:MM`); `collectStats` fills it from `formatDateTime(Date.parse(rec.lastUsed))`;
      usage rows render ` added ${added ?? "?"}  last ${last ?? "?"}` (last column is last →
      alignment preserved)
- [ ] 2.6 Factory calls `installExtensionCommandTracker` once (track = realpath + existsSync
      + `trackExtensionRun`); remove the `/stats` handler's `trackExtensionRun(selfExtensionKey())`
      call and the now-unused `selfExtensionKey` helper
- [ ] 2.7 Run `node test/stats-core.test.ts` → all green

### Phase 3 — Sibling extensions (minimal, audited) [DONE]
- [ ] 3.1 `confirmation-dialog.ts`: add `import { trackExtensionRun } from "./stats.ts"` +
      one `trackExtensionRun(import.meta.url)` at the dialog-show point in the `tool_call`
      handler
- [ ] 3.2 `token-counter.ts`: remove `trackExtensionRun("token-counter")` (buggy key) + import
- [ ] 3.3 `lmstudio.ts`: remove the `/lmstudio` handler's `trackExtensionRun(import.meta.url)`
      + import
- [ ] 3.4 `notify-on-settle.ts`, `reload-resources.ts`: **no change** (event-driven, audited)
- [ ] 3.5 All other extensions: **no change** (covered by G1/G2)
- [ ] 3.6 Check `~/.pi/agent/extensions/extensions.md` (99 B) — if it documents the
      one-line convention, update it: commands are now counted globally; the line is only
      needed for event-driven extensions

### Phase 4 — Docs [DONE]
- [ ] 4.1 README: v1.6 section (global command tracker + tool attribution + last column +
      removed self-reports + fragility note: relies on `AgentSession.prototype
      ._tryExecuteExtensionCommand`, degrades gracefully on pi changes)
- [ ] 4.2 `.pi/SPEC.md`: v1.6 section, checklist, pitfalls, next actions
- [ ] 4.3 Record negative knowledge (above) in SPEC pitfalls

### Phase 5 — Verification [DONE — plus new v16-loader-check.mjs (production identity)]
- [ ] 5.1 `node test/stats-core.test.ts` → all unit tests green (existing 58 + new)
- [ ] 5.2 Integration: existing 5 checks green + **new check 6**: real
      `AgentSession.prototype` patched exactly once after factory run; double install is a
      no-op; usage items from real session + real store have `last` populated for
      non-zero entries
- [ ] 5.3 `npm run -s typecheck` → clean
- [ ] 5.4 `node v15-loader-check.mjs` (re-run as v16) → 7+ extensions, `errors: 0`,
      `/stats` registered
- [ ] 5.5 Eyeball: render usage block (160 cols) with long names → columns aligned incl.
      `last`
- [ ] 5.6 Manual live check instructions for the user (below)

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| pi renames/removes `_tryExecuteExtensionCommand` in a future release | install returns `false` (no crash); integration check 6 fails loudly in the next test run; README documents the dependency + version |
| Prototype patch affects all `AgentSession` instances in-process (incl. SDK) | Side effect is isolated counter write (try/catch, best-effort); no behavior change |
| Double counting after de-dup | Audit done (D5): only command-handler self-reports removed; event-driven ones kept; tests assert exactly-once |
| `sourceInfo.path` ≠ discovery path (symlinks/case) | D4 realpath normalization on both write and read side; fallback to literal |
| Old phantom store keys (e.g. resolved `token-counter`) | Harmless: table iterates loaded resources, not the store; no migration needed |
| Extensions being actively edited by the user (history-view.ts, turn-stats.ts) | v1.6 touches neither file → no conflict surface |
| `existsSync` per tool event | Kernel-cached stat; only for extension-owned tools (built-ins have null owner) |

## Test plan (summary)

- Unit (core): tracker wrap semantics (5 cases), idempotency + graceful degrade,
  `toolOwnerFromList` (4 cases), factory attribution wiring (1), usage last column render +
  alignment (2), `resolveUsageKey` realpath (3), skill counter end-to-end (1–2).
- Integration: real prototype patched-once check; real session + real store → `last` column;
  existing 5 checks must stay green.
- Typecheck: `tsc --strict` clean.
- Loader: pi real `discoverAndLoadExtensions` → 0 errors, `/stats` present.

## Effort

S–M: ~120 lines in stats.ts, ~150 lines of tests, 4 sibling one-liner edits, docs.

## Open questions

- Q1 (answered): date+time for `last used`.
- Q2 (answered by delegation): leave passive extensions at 0 runs (D7/G8).

## Next immediate action

1. Phase 1 (RED tests) → 2. Phase 2 (GREEN in stats.ts) → 3. Phase 3 (siblings) →
   4. Phase 4 (docs) → 5. Phase 5 (verify + hand user the live-check instructions:
   `/reload`, run `/nuke` on a scratch session, let the agent call `fetch`, trigger a
   confirmation dialog, open `/stats`).
