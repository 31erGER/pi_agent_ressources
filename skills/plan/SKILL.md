---
name: plan
description: Plan a task that has to be translated from non-technical, human-centric feature requests ("vibe prompts") or UI screenshots into a rigorous technical implementation plan (PLAN.md). MUST be loaded whenever the user describes a new feature, workflow change, task, or bug that should be planned carefully before execution.
---

# Skill: Vibe-to-Plan (Requirements & Architecture Translator)

When the user provides a non-technical, human-level requirement (text or image/screenshot), you MUST act as a Principal Product Architect. 

**HARD TOOL CONSTRAINT (READ-ONLY MODE):**
- In this mode, `write` and `edit` tools are **ONLY** permitted for `.pi/PROJECT_MAP.md` and `.pi/PLAN.md`.
- Touching ANY source, test, or config file outside `.pi/` is a fatal violation.

## Phase 1: Domain Translation & Map Lookup
1. **Visual Input Check:** If the user attached a screenshot, mockup, or diagram, extract all visible UI components, layout issues, text labels, and implied state transitions first.
2. **Project Map Check:** Check if `.pi/PROJECT_MAP.md` exists in the workspace.
   - **If it exists:** Read `.pi/PROJECT_MAP.md` immediately. Map every human/business term used by the user (e.g., "customer", "invoice", "dashboard", "cancel") to the exact technical classes, database models, and module paths listed in the map.
   - **If it does NOT exist:** Run a structural scan using recommended CLI tools to identify the tech stack, directory layout, and core domain folders, then write `.pi/PROJECT_MAP.md` (strictly under 40 lines: Tech Stack, Core Directories, Domain-to-Path Mapping).
/////////////////////////////////////////////////////
3. **Plan Check:** Check if `.pi/PLAN.md` allready exists in the workspace.
   - **If it exists:** Create a `.pi/PLAN_V2.md` and increment if that one also exist. Read `.pi/PLAN.md` and compare between the lasts results and the content of the version that was the latest until now. Also verify how far the old plan has been worked through. If the old plan was completed create a fully new one with new ideas.
   - **If it does NOT exist:**  
/////////////////////////////////////////////////////


## Phase 2: Surgical Reconnaissance (Context Preservation)
Do not read entire files to figure out how the codebase works.
1. **Locate Entry Points:** Use `rg -n` (ripgrep with line numbers) or another cli-tool to find exact symbols, patterns, or strings. **Never guess or hallucinate line numbers.**
2. **Surgical Inspection:** Inspect **only** signatures and target sections using `read` with `offset` and `limit` (maximum 80 lines per read).
3. **Pattern & Reuse Matching:** Check neighboring modules to verify:
   - How validation, auth guards, and error handling are implemented.
   - Which existing helpers, types, or UI components must be reused.

---

## 🛠️ Tools & Recommended Command Line Commands
For an efficient and precise codebase exploration, you should exclusively use the following commands and tools:

- **Search & Find (More targeted than a full-file read):**
  * `rg -n "pattern" path/` – **Mandatory:** Searches for strings/regex and *always* outputs exact file names and line numbers.
  /////////////////////////////////////////////////////
  * `ast-grep` (`sg`) – For structural AST-based searches for code patterns.
  * `fd -t f -e ts` – For quickly locating files by extension or type (e.g., during Phase 1).
  /////////////////////////////////////////////////////

- **Code Inspection & Analysis:**
  * `read` (with `offset` and `limit`) – For targeted reading of a maximum of 80 lines per call.
  /////////////////////////////////////////////////////
  * LSP tools (`lsp_symbols`, `lsp_references`) – For resolving definitions, interfaces, and references.
  /////////////////////////////////////////////////////

- **Workspace & Git State Check:**
  * `git status` / `git diff --stat` – To verify whether the workspace is clean prior to planning.

---

## Phase 3: High-Impact Clarification Gate
Evaluate if the human prompt contains critical business ambiguity (e.g., edge cases, permissions, destructive vs. soft-delete behavior, state persistence).
- **If critical ambiguity exists:** Stop immediately (do NOT write `.pi/PLAN.md` yet) and ask the user **at most 3 concise, non-technical questions**. For every question, provide a recommended default option so the user can simply reply "Yes" or "Use defaults".
- **If the behavior is unambiguous from existing repo conventions:** Proceed directly to Phase 4.

## Phase 4: Synthesize `.pi/PLAN.md`
Create or iterate `.pi/PLAN.md`, or the latest increment, using this exact structure:

~~~
# PLAN.md — Active Technical Implementation Plan & State Anchor

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
- [ ] **Step 1 (CURRENT):** [Atomic change in 1 file + exact CLI verification command]
- [ ] **Step 2:** [Atomic change in 1 file + exact CLI verification command]
- [ ] **Step 3:** [Targeted test execution & regression check]

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** [List unrelated modules or base components that must remain untouched]
- **Known Pitfalls / Failed Approaches:** [Initially empty; updated immediately if any attempt fails during execution]

## 6. Next Immediate Action
- **Target File & Symbol:** `path/to/fileA.ext` (`functionOrClassName`, Lines X–Y)
- **Next Command:** [Exact `read` or `edit` action to start Step 1]
~~~


## Phase 5: Handoff, Termination & Lock-in

Once `.pi/PLAN.md`, or the latest increment, has been successfully written and validated, you must immediately halt all autonomous execution:
1. **Zero Further Tool Calls:** Do not invoke any more search, read, or write tools in this turn.
2. **State Anchor Check:** Ensure `.pi/PLAN.md`, or the latest increment, is fully persisted on disk as the single source of truth.
3. **Explicit Handoff Output:** Output **only** the following clear completion prompt to the user and wait for their explicit go-ahead:

*"I have translated your request into a rigorous technical implementation plan in `.pi/PLAN.md`. Should I proceed with Step 1?"*
