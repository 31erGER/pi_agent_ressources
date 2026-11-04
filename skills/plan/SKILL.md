---
name: plan
description: Plan a task that has to be translated from non-technical, human-centric feature requests ("vibe prompts") or UI screenshots into a rigorous technical implementation plan (.pi/PLAN.md). MUST be loaded whenever the user describes a new feature, workflow change, task, or bug that should be planned carefully before execution, and whenever an existing .pi/PLAN.md has to be revised, continued, or replaced.
---

# Skill: Vibe-to-Plan (Requirements & Architecture Translator)

When the user provides a non-technical, human-level requirement (text or image/screenshot), act as a Principal Product Architect: translate the intent into an exact, verifiable plan before any code is touched.

## Ground Rules

**HARD TOOL CONSTRAINT (READ-ONLY MODE, Phases 1–5):**
- `write` and `edit` are **ONLY** permitted for `.pi/PROJECT_MAP.md`, `.pi/PLAN.md` and `.pi/.gitignore`.
- `.pi/LOG.md` is only ever appended to with `>>` (see "Work Log & Recap"). Never use `write` on it.
- `bash` is read-only. The only allowed writing commands are `mkdir -p` inside `.pi/`, the `mv` that archives the old plan and log, and the `cp --parents` that creates the baseline snapshot (Phase 4).
- Never run commands that write files as a side effect: no installs (`npm install`, `pip install`), builds, formatters, `--fix` flags, and no `ctags` without `-x` (it would create a `tags` file).
- Touching ANY source, test, or config file outside `.pi/` is a fatal violation.

**GIT SAFETY (always, also after the user's go-ahead):**
- Git is optional. This skill works without it: progress is verified against baseline snapshots (Phase 4).
- Only these read-only git commands are allowed, and only in a repository that already exists: `git status`, `git diff`, `git log`, `git show`, `git ls-files`, `git rev-parse`, `git blame`.
- Every other git command is forbidden, above all `git init`, and also `add`, `commit`, `stash`, `checkout`, `switch`, `restore`, `reset`, `clean`, `rm`, `mv`, `rebase`, `merge`, `pull`, `push`, `branch`, `tag`, `config`. These commands can hide, overwrite, or delete the user's work, and a repository created in the wrong place (e.g. the home directory) silently covers everything below it.
- Never create a repository on your own initiative, not even "to make verification easier", and never suggest one. A directory without git is a normal state, not a problem to fix.
- Single exception: the user asks for one specific git command in their own message (e.g. "run git init in ~/projects/shop"). A "yes", "ok", "go" or "use defaults" in reply to another question is NOT such a request. Even then, never run `git init` in `$HOME`, `/` or a system directory.
- If a command is blocked by a guard or declined by the user, do not retry it in another form (no `sh -c`, aliases, scripts, or full paths). Continue without it or ask the user.

**Single source of truth:** Progress is determined by comparing the files with the plan's baseline snapshot, never by checkboxes alone. The checkboxes in `.pi/PLAN.md` are the human-readable mirror of that comparison, and you keep them in sync (Phase 1.3 and Phase 6).

**Timestamps:** Take every date and time from the `date` command. Never invent or estimate a timestamp; you do not know the current time.

**Memory:** Compaction summarizes older messages and loses details. Everything that happens under this skill is recorded in `.pi/LOG.md`, and after a compaction or in a new session you recap from it before acting (see "Work Log & Recap").

**Tools:** Your built-in tools are `read`, `write`, `edit` and `bash`. All commands in the Tool Reference at the end of this skill run via `bash`. Do NOT call tools that are not listed there (e.g. `lsp_symbols`, `lsp_references`); they do not exist in this environment.

## Phase 1: Domain Translation & Map Lookup
0. **Project Root & Tool Check (once per session):**
   `pwd; echo "HOME=$HOME"; git rev-parse --show-toplevel 2>/dev/null || echo "no git repository"`
   `for t in rg ctags jq ast-grep git; do command -v "$t" >/dev/null && echo "ok      $t" || echo "MISSING $t"; done`
   - **Project root** = the git top level if pi runs inside an existing repository, otherwise the current directory.
   - The project root must never be `$HOME`, `/`, or a system directory (`/etc`, `/usr`, `/var`, `/opt`, `/boot`, `/root`), even if `$HOME` itself is a git repository. If it would be: do not scan it and do not create `.pi/` there. If the user's request names a project directory, use that one; otherwise stop now and ask: "Which project directory is this about?" (no default).
   - If `rg --files --no-require-git | head -20001 | wc -l` prints `20001`, the directory is too large to be a single project: ask which subdirectory is meant.
   - If the project root differs from pi's working directory, prefix every bash command with `cd '<root>' && ` and use absolute paths (`<root>/.pi/PLAN.md`) for `read`, `write` and `edit`. All `.pi/` paths in this skill are relative to the project root.
   - Without a git repository, add `--no-require-git` to every `rg` call; otherwise `rg` ignores `.gitignore` and searches `node_modules/` and build output.
   - For every missing tool, use the fallback named in the Tool Reference.
1. **Visual Input Check:** If the user attached a screenshot, mockup, or diagram, extract all visible UI components, layout issues, text labels, and implied state transitions first. Keep the exact visible labels: they are the fastest way into the code (`rg -n -F 'Label text'`, Phase 2).
2. **Project Map Check:** Run `ls -1 .pi/ .pi/archive/ .pi/baseline/ 2>/dev/null`. (Use `ls`, not `rg` or `fd`: they skip hidden directories like `.pi/` by default.)
   - **If `.pi/PROJECT_MAP.md` exists:** Read it immediately. Map every human/business term used by the user (e.g., "customer", "invoice", "dashboard", "cancel") to the exact technical classes, database models, and module paths listed in the map. Spot-check two or three mapped paths with `ls`; if one no longer exists or the section "Verification Commands" is missing, update the map.
   - **If it does NOT exist:** Run a structural scan (Tool Reference: directory overview with `rg --files`, `jq` on `package.json` or `read` on `pyproject.toml` / `Cargo.toml` / `go.mod` / `Makefile`, `rg -i -l` for domain terms). Then write `.pi/PROJECT_MAP.md`, strictly under 40 lines, with exactly these sections: **Tech Stack**, **Core Directories**, **Domain-to-Path Mapping**, **Verification Commands** (exact commands for: all tests, a single test file, lint, type check, build; only commands that really exist in the project). Every plan step needs a concrete verification command, and this section is where it comes from.
3. **Plan Check:** Does `.pi/PLAN.md` exist (see the `ls` output from step 2)?
   - **If it does NOT exist:** Do not create a placeholder. Continue with Phase 2; the plan is written in Phase 4.
   - **If it exists:**
     a. Read it completely (several `read` calls of max. 80 lines if needed), then recap `tail -n 60 .pi/LOG.md` if the log exists. Take `Created` and `Baseline` from the plan's header.
     b. Determine the real progress from the baseline snapshot:
        * Overview of all snapshotted files (replace `<ts>` with the folder name from `Baseline:`):
          `B=.pi/baseline/<ts>; (cd "$B" && find . -type f | sed 's|^\./||') | while read -r f; do cmp -s "$B/$f" "$f" 2>/dev/null && echo "unchanged $f" || echo "CHANGED   $f"; done`
        * Evidence for one step: `diff -u .pi/baseline/<ts>/path/to/file path/to/file | head -80`
        * Files the plan creates are not in the snapshot: `ls path/to/newfile` shows whether they exist now.
        * Only if a git repository already exists: `git status --short | head -50` additionally shows changes outside the plan's file map. Mention them in the new plan; never revert them.

        A step counts as done only if the diff shows the planned change in the step's target file (or the planned new file exists). If the evidence is unclear, the step counts as open. If the header has no `Baseline:` field or the snapshot folder is missing, progress is **unverified**: keep the checkboxes as they are and state "unverified" in the new plan.
     c. Sync the checkboxes of `.pi/PLAN.md` with this result (`edit`): tick every verified step, untick every step without evidence, and set `Last verified:` in its header to the output of `date '+%Y-%m-%d %H:%M'` (add the field if missing). This way the human sees the true state, also later in the archive.
     d. Decide which case applies and state it explicitly:
        * **Completed** (all steps verified): The request is a new task. Write a completely new plan based only on the current request; do not copy steps from the old plan. Carry over only entries from "Known Pitfalls" that still apply to the code you will touch. Old plan status: `completed`.
        * **Partially completed, same feature:** Carry completed steps over as `[x]` with the suffix `(done in previous plan)`; they are not re-verified against the new snapshot. Re-validate every open step against the current code (line numbers have likely shifted; locate them again with `rg -n`) and integrate what the new request changes. Old plan status: `superseded`.
        * **Partially completed, unrelated request:** Do not silently abandon the old plan. This becomes a mandatory question in Phase 3.
     e. Do not archive yet. Archiving happens at the start of Phase 4, so an active plan still exists while questions are open.

## Phase 2: Surgical Reconnaissance (Context Preservation)
Do not read entire files to figure out how the codebase works: the context window is limited, and every unnecessary line pushes out something important.
1. **Locate Entry Points:** Use `rg` (see the Tool Reference for many patterns) to find exact symbols, strings, UI labels, routes, and usages. **Never guess or hallucinate line numbers.**
2. **Outline Before Reading:** Run `ctags -x --sort=no path/to/file` to see every function, class, and method with its start line. The start line of the next symbol marks where the current one ends.
3. **Surgical Inspection:** Inspect **only** signatures and target sections using `read` with `offset` and `limit` (maximum 80 lines per read).
4. **Pattern & Reuse Matching:** Check neighboring modules to verify:
   - How validation, auth guards, and error handling are implemented.
   - Which existing helpers, types, or UI components must be reused.
5. **Find the Tests:** `rg -l 'SymbolName' -g '*.{test,spec}.*'` shows which tests already cover the code you will change.

## Phase 3: High-Impact Clarification Gate
Evaluate if the human prompt contains critical business ambiguity (e.g., edge cases, permissions, destructive vs. soft-delete behavior, state persistence).
- **If critical ambiguity exists:** Stop immediately (do NOT write a new plan yet) and ask the user **at most 3 concise, non-technical questions**. For every question, provide a recommended default option so the user can simply reply "Yes" or "Use defaults".
- **Mandatory question if Phase 1.3 found an unfinished plan for an unrelated task:** "There is an unfinished plan for <topic> (<done>/<total> steps done). Should I park it, discard it, or finish it first? Recommended: park it." This counts toward the 3 questions.
  - *park* → old plan status `parked`
  - *discard* → old plan status `discarded` (it is still archived, never deleted)
  - *finish* → do not write a new plan; go directly to Phase 5 and hand off with the old plan's `(CURRENT)` step.
- Log every answer that changes the plan as a `DECISION` entry (see "Work Log & Recap").
- **If the behavior is unambiguous from existing repo conventions:** Proceed directly to Phase 4.

## Phase 4: Synthesize `.pi/PLAN.md`
1. **Archive the old plan and log (only if `.pi/PLAN.md` exists):**
   - Set the `Status:` field in the old plan's header to the status decided in Phase 1.3 or Phase 3 (`completed`, `superseded`, `parked` or `discarded`).
   - Timestamp: the old plan's `Created:` value written as `YYYY-MM-DD_HHMM` (e.g. `Created: 2026-11-03 14:05` → `2026-11-03_1405`). If the header has no `Created:` value, use the file's modification time: `date -r .pi/PLAN.md '+%Y-%m-%d_%H%M'`.
   - `mkdir -p .pi/archive && mv .pi/PLAN.md .pi/archive/PLAN_<timestamp>.md`
   - If `.pi/LOG.md` exists: `mv .pi/LOG.md .pi/archive/LOG_<timestamp>.md`
   - If a target file name already exists, append `_2`, `_3`, … Never delete or overwrite a plan, a log, or a snapshot. The old snapshot stays in `.pi/baseline/<timestamp>/`.
2. **Collect header data:** `date '+%Y-%m-%d %H:%M'` (Created; the same value as `YYYY-MM-DD_HHMM` is the new snapshot folder name) and, only in an existing repository, `git rev-parse --short HEAD 2>/dev/null || echo none` (informational only).
3. **Write the new `.pi/PLAN.md`** using this exact structure. Text in `[brackets]` is an instruction: replace it, and delete the optional header line if it does not apply.

~~~
# PLAN.md — Active Technical Implementation Plan & State Anchor
> Created: [YYYY-MM-DD HH:MM from `date`] · Baseline: `.pi/baseline/[YYYY-MM-DD_HHMM]/` · Git: [short hash, or none] · Status: active · Last verified: —
> After a compaction or in a new session: read this file and `tail -n 60 .pi/LOG.md` before doing anything else.
> Supersedes: `.pi/archive/PLAN_[YYYY-MM-DD_HHMM].md` ([status]; verified progress [done]/[total] steps) — Delta: [one sentence on what changed — delete this line if there was no previous plan]

## 1. Human Requirement (Original Intent)
> [Concise summary of what the user wants from a human/product perspective]

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** [How the feature works technically in 2-3 sentences]
- **Data / Control Flow:** `[Entry/UI] -> [Controller/Route] -> [Service/Domain] -> [Persistence/State]`
- **Reuse & Conventions:** [Exact existing helpers, components, or error patterns to reuse]
- **Acceptance Criteria:**
  1. [Testable criterion 1]
  2. [Testable criterion 2]

## 3. Surgical File Map (Strict Scope Boundary)
- `path/to/fileA.ext` (Symbol: `functionOrClassName`, Lines X–Y: [Exact modification and why])
- `path/to/fileB.ext` (Symbol: `functionOrClassName`, Lines X–Y: [Exact modification and why])
- `path/to/testFile.ext` (Symbol: `testSuiteName`, Lines X–Y: [Unit/integration test to add or update])

## 4. Atomic Execution Checklist
> Bookkeeping: the baseline snapshot is the single source of truth; these boxes mirror it for humans. Tick a box only when `diff -u` against the snapshot shows the step's change (or the planned new file exists) AND its verification command passed. Then move `(CURRENT)` to the next open step, update section 6 and `Last verified:`, and append a log entry. Every failed attempt goes into `.pi/LOG.md`; lessons for the future also go into section 5.
- [ ] **Step 1 (CURRENT):** [Atomic change in 1 file + exact verification command from PROJECT_MAP "Verification Commands"]
- [ ] **Step 2:** [Atomic change in 1 file + exact verification command]
- [ ] **Step 3:** [Targeted test execution & regression check]

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** [List unrelated modules or base components that must remain untouched]
- **Known Pitfalls / Failed Approaches:** [Initially empty or carried over from the previous plan; one line per lesson, details stay in the log]

## 6. Next Immediate Action
- **Target File & Symbol:** `path/to/fileA.ext` (`functionOrClassName`, Lines X–Y)
- **Next Command:** [Exact `read` or `edit` action to start the (CURRENT) step]
~~~

4. **Create the baseline snapshot** of every file in section 3 that already exists (files the plan will create are skipped):
   `mkdir -p .pi/baseline/<YYYY-MM-DD_HHMM> && cp --parents path/to/fileA.ext path/to/fileB.ext .pi/baseline/<YYYY-MM-DD_HHMM>/`
   If `.pi/.gitignore` does not exist, create it with the single line `baseline/`, so snapshots never end up in a repository.
5. **Log the plan:** append a `PLAN` entry to `.pi/LOG.md` (plan created, previous plan archived as …, snapshot folder).

## Phase 5: Handoff, Termination & Lock-in
Once `.pi/PLAN.md`, the snapshot, and the log entry have been written, immediately halt all autonomous execution:
1. **Zero Further Tool Calls:** Do not invoke any more search, read, or write tools in this turn.
2. **State Anchor Check:** `.pi/PLAN.md` is fully persisted on disk as the only active plan; a previous plan exists only in `.pi/archive/`.
3. **Explicit Handoff Output:** Output **only** the following completion prompt and wait for the user's explicit go-ahead (`<N>` is the number of the step marked `(CURRENT)`):

*"I have translated your request into a rigorous technical implementation plan in `.pi/PLAN.md`. Should I proceed with Step <N>?"*

- If a previous plan was archived, insert this sentence before the question: *"The previous plan is archived as `.pi/archive/PLAN_<timestamp>.md` (status: <status>)."*
- If the user chose to finish the old plan (Phase 3), output instead: *"The unfinished plan in `.pi/PLAN.md` stays active. Should I proceed with Step <N>?"*

## Phase 6: Checklist Bookkeeping During Execution (only after explicit go-ahead)
Read-only mode ends only when the user explicitly approves execution, and only for the files listed in section 3 of `.pi/PLAN.md`. GIT SAFETY still applies in full. The checklist is how the human follows your progress, so keep it current:
1. Work on exactly one step at a time: the step marked `(CURRENT)`.
2. After the change, run the step's verification command.
3. **Passed:** Confirm the change with `diff -u .pi/baseline/<ts>/path path | head -80` (or `ls` for a new file). Then tick the box, move `(CURRENT)` to the next open step, update section 6, set `Last verified:` in the header (`date '+%Y-%m-%d %H:%M'`), and append a `STEP done` log entry.
4. **Failed:** Leave the box unticked and append an `attempt N · FAILED` log entry before trying again. If the failure teaches something for the future, add one line to section 5 "Known Pitfalls / Failed Approaches".
5. **Undo:** Undo your own changes with `edit`. Restoring a whole file from the snapshot (`cp .pi/baseline/<ts>/path path`) overwrites it completely, so do it only after the user approved it in their own message.
6. Never tick a box on intention alone. If the snapshot diff does not show the change, the step is not done.
7. When all boxes are ticked and verified, set `Status: completed` in the header and log it.

## Work Log & Recap (`.pi/LOG.md`)
`.pi/PLAN.md` says what should happen; `.pi/LOG.md` records what actually happened. The log is your memory across compactions and sessions.

**When to write:** immediately, never batched (a compaction can happen at any time): after creating or archiving a plan, after every user decision, after every completed step, and after every attempt that failed, including debugging attempts.

**How to write:** append only, with this bash pattern. The quoted `'EOF'` keeps backticks and `$` literal. Never use `write` on this file: it would overwrite the history.
~~~bash
{ echo; echo "### $(date '+%Y-%m-%d %H:%M') · Step <N> · attempt <M> · FAILED"; cat <<'EOF'
- Did: <what was changed or tried, with file and symbol>
- Command: `<exact command>` → exit <code>
- Result: <first relevant error line(s) or key output, max 3 lines>
- Conclusion: <what this rules out, and what to try next>
EOF
} >> .pi/LOG.md
~~~
Heading types: `PLAN`, `DECISION`, `STEP done`, `attempt <M> · FAILED`, `attempt <M> · OK`, `NOTE`. For `PLAN`, `DECISION` and `STEP done`, one or two lines are enough.

**Rules:**
- Facts, not hopes: the exact command, its exit code, and the real output. Never write "fixed" before the verification command passed.
- Never copy secrets, tokens, passwords, or `.env` values into the log.
- Do not log reconnaissance (searches and reads); the log must stay short enough to recap.

**Recap:** After a compaction (you see a summary instead of the earlier conversation), at the start of a new session, or whenever you are unsure what already happened, first read `.pi/PLAN.md` and `tail -n 60 .pi/LOG.md`, before any other action. Base your next step on that:
- Never repeat an attempt the log shows as failed, unless you can name what is different now.
- After 3 failed attempts on the same step, stop. Summarize the 3 attempts for the user in a few lines and ask how to proceed, instead of trying a 4th variant.

---

## 🛠️ Tool Reference (all via `bash`)
Keep every output small, because the context window is limited: use `-M 200`, `-l`, `-c` or `| head -50` whenever a result could be long.

### `rg` (ripgrep) – primary search tool, mandatory
`-n` always prints file names and line numbers. Put patterns in **single quotes**; bash expands `$` inside double quotes. `rg` skips hidden files and directories, so `.pi/` is not searched. It respects `.gitignore` only inside a git repository; without one, add `--no-require-git` to every call. (`fd` is not used: on Ubuntu its binary is called `fdfind`, and `rg --files` covers the same need.)
- `rg -n -M 200 'pattern' src/` – basic search; `-M 200` truncates overlong (minified) lines
- `rg -n -F 'Cancel subscription' src/` – exact text without regex: UI labels from screenshots, or strings containing `( ) . $ [`
- `rg -n -i -l 'invoice' src/` – which files mention a business term (case-insensitive, file names only)
- `rg -nw 'InvoiceService' src/` – whole word only: all references to a symbol
- `rg -n '(class|function|interface|type|def)\s+InvoiceService\b' src/` – where a symbol is defined
- `rg -n 'from .*invoice-service' src/` – who imports a module
- `rg -n '\.(get|post|put|patch|delete)\(' src/routes/` – route / endpoint definitions
- `rg -n -C 3 'throw new' src/billing/` – hits with 3 lines of context (`-A 3` after only, `-B 3` before only)
- `rg -n -e 'cancelInvoice' -e 'voidInvoice' src/` – several patterns at once
- `rg -n -t ts 'cancel' src/` – one file type only (`-t ts` includes `.tsx`; also `-t py`, `-t js`; full list: `rg --type-list`)
- `rg -n 'cancelInvoice' -g '!*.test.ts' src/` – exclude files by glob
- `rg -l 'cancelInvoice' -g '*.{test,spec}.*' src/` – which test files cover a symbol
- `rg -c 'TODO|FIXME' src/` – number of hits per file
- `rg -n -m 1 'Invoice' src/` – only the first hit per file
- `rg -oIN 'process\.env\.[A-Z0-9_]+' src/ | sort | uniq -c | sort -rn` – inventory of all environment variables in use (`-o` match only, `-I` no file name, `-N` no line number)
- `rg --files --no-require-git | cut -d/ -f1-2 | sort | uniq -c | sort -rn | head -30` – directory overview with file counts (works with and without git)
- `rg --files -t ts src/` – list files by type
- `rg --files -g '*invoice*'` – find files by name
- `rg -n --hidden -g '!.git' 'pattern' .` – also search dotfiles such as `.github/` or `.env.example`
- Files in `.pi/`: pass the path explicitly (`rg -n 'pattern' .pi/PLAN.md`) or use `ls` / `read`.

### `ast-grep` – structural search on the syntax tree (optional)
Use it when a regex would be fragile: calls with a specific argument shape, JSX elements, nested constructs. Fallback if missing: `rg`.
- Always call it `ast-grep`, never `sg`: on Ubuntu, `sg` is a different system command (switch group).
- Always put the pattern in single quotes, otherwise bash replaces `$URL` with an empty string and nothing matches.
- `$NAME` matches exactly one syntax node, `$$$` matches any number of nodes (e.g. all arguments).
- `-l` must match the file type: `ts` for `.ts`, `tsx` for `.tsx`, `js`, `py`, `rust`, `go`, …
- `ast-grep -p 'fetch($URL)' -l ts src/` – all `fetch` calls with exactly one argument
- `ast-grep -p 'useEffect($$$)' -l tsx src/` – all `useEffect` calls in `.tsx` files
- `ast-grep -p 'await $DB.query($$$)' -l ts src/` – all awaited `query` calls on any object
- If a pattern finds nothing although `rg` finds the code, the pattern is wrong: simplify it or use `rg`.

### `ctags` (Universal Ctags) – symbol outline with line numbers
Output columns: name, kind, start line, file, source line.
- `ctags -x --sort=no path/to/file.ts` – all functions, classes, and methods of one file in file order; use it to choose `offset` / `limit` for `read`
- `rg --files -t ts src/billing/ | ctags -x --sort=no -L -` – outline of a whole directory (the file list comes from `rg`, so ignore rules are respected)
- `rg --files -t ts src/ | ctags -x -L - | rg '^InvoiceService\s'` – where a symbol is defined (file + line)
- **Always use `-x`.** Without it, ctags writes a `tags` file into the project, which violates read-only mode.
- Empty output for a `.tsx` file: add `--map-TypeScript=+.tsx`. Fallback if ctags is missing: `rg -n '(class|function|def|interface)\s' path/to/file`.
- References are not ctags' job: use `rg -nw 'SymbolName'`.

### Baseline snapshot – progress evidence and safety copy
- `mkdir -p .pi/baseline/<ts> && cp --parents path/a path/b .pi/baseline/<ts>/` – snapshot of the plan's files (Phase 4)
- `B=.pi/baseline/<ts>; (cd "$B" && find . -type f | sed 's|^\./||') | while read -r f; do cmp -s "$B/$f" "$f" 2>/dev/null && echo "unchanged $f" || echo "CHANGED   $f"; done` – which snapshotted files changed
- `diff -u .pi/baseline/<ts>/path/to/file path/to/file | head -80` – what exactly changed in one file

### `git` – read-only, only in a repository that already exists (see GIT SAFETY)
- `git rev-parse --show-toplevel 2>/dev/null || echo "no git repository"` – is there a repository, and where is its root
- `git status --short | head -50` – uncommitted (`M`) and untracked (`??`) files
- `git ls-files '*invoice*'` – tracked files by name
- `git log --oneline -n 15 -- src/billing/` – recent changes in one area
- `git log -S'cancelInvoice' --oneline` – commits that added or removed a symbol
- `git diff --stat` / `git diff -- path/to/file | head -80` – uncommitted changes
- `git blame -L 40,60 path/to/file` – who changed these lines, and in which commit

### Small helpers
- `jq '{scripts, dependencies, devDependencies}' package.json` – tech stack and available npm scripts (for other stacks, `read` `pyproject.toml`, `Cargo.toml`, `go.mod`)
- `rg -n '^[A-Za-z0-9_.-]+:' Makefile` – Makefile targets
- `wc -l path/to/file` – file length before reading
- `date '+%Y-%m-%d %H:%M'` – current time for plan headers and log entries; `date -r FILE '+%Y-%m-%d_%H%M'` – modification time of a file
- `ls -1 .pi/ .pi/archive/ .pi/baseline/ 2>/dev/null` – contents of `.pi/`
- `tail -n 60 .pi/LOG.md` – the most recent log entries
