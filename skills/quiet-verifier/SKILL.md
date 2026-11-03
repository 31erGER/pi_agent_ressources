---
name: quiet-verifier
description: Executes unit tests, typechecks, linters, and build commands with strict output filtering and fail-fast flags so massive console logs or stack traces never flood the context window.
---

# Skill: Quiet Verifier (Token-Safe Testing & Verification)

Running an unfiltered `npm test`, `pytest`, or `cargo test` command on a large codebase can dump 30,000+ tokens of console logs into your context window, immediately triggering a destructive auto-compaction. Follow these rules for EVERY verification command.

## 1. The 3 Iron Laws of Verification
1. **Scope to Single Files:** Never run the entire repository test suite during iterative coding. Always pass the specific test file or test name matching the module you edited.
2. **Use Quiet & Fail-Fast Flags:** Always pass flags that suppress passing test chatter and abort after the first 1–3 failures (`--bail`, `-x`, `-q`).
3. **Mandatory Output Piping:** Every build, test, typecheck, or linter command executed via `bash` **MUST** end with `2>&1 | head -n 60` or `2>&1 | tail -n 60`.

## 2. Standard Quiet Command Patterns by Stack

*(Always check `.pi/PROJECT_MAP.md` first for project-specific commands; otherwise use these patterns)*

### TypeScript / JavaScript (Node, Vitest, Jest, Playwright)
- **TypeScript Typecheck (first 50 error lines only):**
  ~~~bash
  npx tsc --noEmit --pretty false 2>&1 | head -n 50
  ~~~
- **Vitest (single file, dot reporter, bail on first error):**
  ~~~bash
  npx vitest run path/to/file.test.ts --reporter=dot --bail=1 2>&1 | tail -n 60
  ~~~
- **Jest (single file, silent console, bail):**
  ~~~bash
  npx jest path/to/file.test.ts --silent --bail 2>&1 | tail -n 60
  ~~~
- **ESLint / Biome (single file, quiet/errors only):**
  ~~~bash
  npx eslint path/to/file.ts --quiet 2>&1 | head -n 50
  ~~~

### Python (Pytest, Ruff, Mypy)
- **Pytest (single file, stop on first failure, short traceback):**
  ~~~bash
  pytest path/to/test_file.py -q -x --tb=short --no-header 2>&1 | tail -n 60
  ~~~
- **Ruff & Mypy (targeted check):**
  ~~~bash
  ruff check path/to/file.py --quiet 2>&1 | head -n 50
  mypy path/to/file.py --no-error-summary 2>&1 | head -n 50
  ~~~

### Rust / Go / .NET (C#)
- **Rust (`cargo`):**
  ~~~bash
  cargo check --message-format=short 2>&1 | head -n 60
  cargo test test_name -- --quiet 2>&1 | tail -n 60
  ~~~
- **Go:**
  ~~~bash
  go test -run TestName ./path/to/pkg 2>&1 | tail -n 60
  ~~~
- **C# (.NET):**
  ~~~bash
  dotnet build --no-restore -v q /clp:ErrorsOnly 2>&1 | head -n 60
  dotnet test --no-build --filter "FullyQualifiedName~TestName" -v q 2>&1 | tail -n 60
  ~~~

## 3. Recording Verification Failures
If a test or build fails and your first fix attempt does not resolve it:
- Immediately record the failed hypothesis and exact error reason under `## 5. Negative Knowledge` in `.pi/SPEC.md` before trying a second approach.