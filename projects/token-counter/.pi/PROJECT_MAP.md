# PROJECT_MAP — token-counter extension project

## Tech Stack
- TypeScript, pi coding agent extension API (docs: `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`)
- Extensions are plain `.ts` files (or dirs with `index.ts`) in `/home/julian/.pi/agent/extensions/`, loaded by pi via jiti
- Node v26.13.1: native TS type-stripping + `node --test` (no tsc anywhere in the tree, no package.json in project)
- `getAgentDir()` honors `PI_CODING_AGENT_DIR` (verified in pi's `dist/config.js`) — used for hermetic tests

## Core Directories
- `/home/julian/.pi/agent/extensions/` — global extensions (`token-counter.ts` = the only extension file we change)
- `/home/julian/.pi/agent/extensions/token-counter-ledger/` — helper module dir (NOT an extension: no index.ts, pi discovery skips it)
- `/home/julian/.pi/agent/projects/token-counter/` — project root for this work (`.pi/PLAN.md`, `.pi/LOG.md`, `test/`)
- `/home/julian/.pi/agent/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl` — session files (seed source only)
- `/home/julian/.pi/agent/discarded-sessions/` — nuke fallback dir (`trash`/trash-cli NOT installed on this machine); also a seed source
- `/home/julian/.pi/agent/token-ledger.jsonl` — NEW append-only ledger, one line per GPU call (runtime data, created at first run)

## Domain-to-Path Mapping
- "global token counter" → `extensions/token-counter.ts` (event handlers append ledger lines; footer shows ledger sum)
- "count at the source" → events `turn_end` / `session_compact` / `session_tree` (usage verified in pi's `dist/core/extensions/types.d.ts`)
- "one-time seed" → `seedIfNeeded()` in `extensions/token-counter-ledger/ledger.ts` (scans sessions/ + discarded-sessions/ exactly once)
- "usage semantics" → `usageOf()` in `ledger.ts` (assistant message.usage + compaction/branch_summary/usage entries — unchanged from old scanner)
- "nuke / nuke-exit session" → `extensions/nuke-session.ts` (NOT modified in this design; nuking can no longer affect the counter)

## Verification Commands
- All tests: `cd /home/julian/.pi/agent/projects/token-counter && node --test test/ 2>&1 | tail -20`
- Single test file: `cd /home/julian/.pi/agent/projects/token-counter && node --test test/token-ledger.test.ts 2>&1 | tail -20`
- Ledger sanity: `jq -c . /home/julian/.pi/agent/token-ledger.jsonl | tail -5`
- Extension loads cleanly: start `pi` in any project (no "valid factory function" errors; footer shows Σ totals)
