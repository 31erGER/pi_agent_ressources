---
name: surgical-reader
description: Enforces token-efficient, surgical code navigation and reading in large codebases. Prevents full-file reads (>150 lines) and protects the context window from bloat and premature auto-compaction.
---

# Skill: Surgical Reader (Context-Preservation Protocol)

Reading large source files from top to bottom wastes tens of thousands of tokens, degrades attention in the middle of the context window (*Context Rot*), and triggers destructive auto-compactions. You MUST obey these 4 laws on every file operation.

## Law 1: The 150-Line Hard Limit
- Before reading any unfamiliar file, check its line count or symbol outline first:
  ~~~bash
  wc -l path/to/file
  ~~~
- If a file has **more than 150 lines**, you are **STRICTLY FORBIDDEN** from calling the `read` tool without explicit `offset` and `limit` parameters!

## Law 2: X-Ray First, Scalpel Second
Before reading a large file, extract its structural skeleton (line numbers of classes, functions, interfaces, or search hits). This costs ~100 tokens instead of 15,000 tokens:

1. **If LSP tools (`pi-lsp-adapter`) are available:**
   Use `lsp_symbols` on the file, or `lsp_definition` / `lsp_references` on a symbol to get exact line numbers immediately.

2. **Structural Outline via `ripgrep` (`rg`):**
   ~~~bash
   rg -n "^(\s*)(export |async |public |private |protected |static )*(class|interface|type|enum|function|def|fn|struct|impl|mod|const [A-Za-z0-9_]+\s*=)" path/to/file
   ~~~

3. **Targeted Keyword Search with Line Numbers:**
   ~~~bash
   rg -n -C 2 "targetSymbolOrMethodName" path/to/file
   ~~~

4. **Syntax-Aware Search via `ast-grep` (`sg`) (if installed):**
   ~~~bash
   sg --pattern 'function $NAME($$$) { $$$ }' path/to/file
   ~~~

## Law 3: Windowed `read` Calls (`offset` + `limit`)
Once Law 2 reveals that the target function or class starts at line $L$:
- Call `read` with `offset: L - 10` (minimum 1) and `limit: 80` (or the exact span of the function).
- Never load 1,000 lines of unrelated boilerplate just to inspect a 40-line method.

## Law 4: High-Precision `edit` Calls
- Always read the target line range fresh before invoking `edit` if many turns or a compaction have occurred since your last read.
- Keep `oldText` in `edit` minimal but uniquely anchored (include 2–3 unchanged lines above and below the modified lines so the patch matches unambiguously).