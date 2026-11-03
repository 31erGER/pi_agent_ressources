---
name: subagent-orchestrator
description: Governs the delegation of codebase exploration, impact analysis, and multi-file searches to isolated subagents on a local single-GPU setup. Keeps the main context clean without overflowing VRAM.
---

# Skill: Subagent Orchestrator (Single-GPU / Local LLM Protocol)

You are running on a local single-GPU setup with a single active KV-cache slot. Subagents are your primary weapon to keep your main context window clean during exploration—but they must be orchestrated under strict hardware rules.

## Rule 1: Strict Sequential Execution (Zero Parallelism)
- **NEVER spawn multiple subagents in parallel in a single turn!**
- Always invoke **at most ONE subagent at a time**, wait for its summary response, and only then decide on the next action.
- Parallel subagents on a single local GPU cause request queueing, thrash the LM Studio prompt cache, and risk VRAM Out-Of-Memory errors.

## Rule 2: When to Delegate to a Subagent
Do NOT pollute the main context window with blind exploratory searches. Spawn a subagent whenever a task requires:
- Searching across more than 3 unknown files or directories to locate where a feature is implemented.
- Tracing all callers/consumers of a function, API endpoint, or event across the repository (Impact Analysis).
- Inspecting existing test files to learn how mocks, fixtures, or database setup are written in this project.

*(Note: Once `.pi/SPEC.md` already lists the exact file paths and line numbers, do NOT spawn subagents—use `surgical-reader` directly in the main agent!)*

## Rule 3: How to Invoke a Subagent
- **If the `subagent` tool (`pi-subagents` extension) is installed:** Call the `subagent` tool with a single task.
- **If no subagent extension is installed:** Spawn an isolated, non-interactive `pi` child process via the `bash` tool:
  ~~~bash
  pi -p --no-session "Your strict exploration prompt here"
  ~~~

## Rule 4: The Mandatory Subagent Output Contract
Every prompt you send to a subagent MUST include this strict output contract so the subagent does not dump raw source code back into your main context:

~~~text
EXPLORATION TASK: [Describe exactly what to find or analyze]

CONSTRAINTS:
1. Do NOT modify any files.
2. Use `rg -n`, `fd`, and windowed `read` (`offset`/`limit`). Do not read full large files.
3. STRICT OUTPUT FORMAT (Maximum 350 words total, NO raw code dumps):
   - **Matched Files & Exact Line Ranges:** (`path/to/file:start-end`)
   - **Key Signatures / Types:** (Only function headers, interfaces, or schema fields)
   - **Architectural Summary:** (How the components interact and where the change must hook in)
~~~