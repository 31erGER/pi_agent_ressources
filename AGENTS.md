# Global instructions
As soon as your task is to programm something allways prioritize Test Driven Development (TDD) than do so.
Prefer simple, robust and performant solutions and check if something can get broken before making changes. Make sure to test against breaking changes.
Allways start your answer with a short abstract of what you want to say. After that you can write down your full response.
The last part every answer has to include is instructions for the user and what he has to do next. If there is nothing to do also tell the user.
Allways stick to english as our primary communication language.
Whenever you think you read something interesting about the user you can persist this knowledge into `~/.pi/agent/USER.md` so you can evolve into an even better assistant.

<!-- pi-env:start (managed by setup-pi-tools.sh) -->
## Safety rules (all projects)
- Git: use only read-only git commands (status, diff, log, show, ls-files, rev-parse, blame). Never run `git init` or any other git command that changes or creates a repository, unless I ask for that exact command in my own message. A "yes" to another question is not such a request.
- Never delete directories recursively (`rm -r`, `rm -rf`) and never overwrite files outside the scope of the current task without asking me first.
- If a command is blocked by the confirmation-dialog extension or declined by me, do not retry it in another form (no `sh -c`, aliases, scripts, or full paths). Continue without it, or ask me to run it myself.
- Never create `.pi/` files or scan the whole directory when running directly in my home directory; ask which project directory is meant.

## Planning and memory
- When a task should be planned before it is executed (new feature, workflow change, larger bug), use the `plan` skill.
- If the project has `.pi/LOG.md`: after a compaction or at the start of a session, read `.pi/PLAN.md` and `tail -n 60 .pi/LOG.md` before doing anything else.

## CLI tools (call them via bash)
- `rg` (ripgrep): search code and text. Use `-n`, single-quoted patterns, `-M 200`; `-l` for file names only, `-F` for literal text, `-w` for whole words, `-U` for patterns spanning several lines. `rg --files -g '*name*'` finds files by name.
- `ctags -x --sort=no <file>`: outline of a file (functions, classes, methods with line numbers). Always use `-x`; without it ctags writes a `tags` file.
- `jq '<filter>' <file.json>`: query JSON (e.g. `jq '.scripts' package.json`) instead of reading the whole file.
- Read files with `read` and `offset`/`limit` instead of `cat`; check the length with `wc -l` first. Keep command output small (`| head -50`).
<!-- pi-env:end -->
