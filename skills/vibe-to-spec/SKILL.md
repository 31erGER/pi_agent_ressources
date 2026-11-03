---
name: vibe-to-spec
description: Translates non-technical, human-centric feature requests ("vibe specs") into a rigorous technical specification (.pi/SPEC.md). MUST be loaded whenever the user describes a new feature, workflow change, or bug from a user/business perspective without specifying exact files or code structures.
---

# Skill: Vibe-to-Spec (Requirements & Architecture Translator)

When the user provides a non-technical, human-level requirement, you MUST act as a Principal Product Architect. **You are strictly forbidden from modifying any production code until `.pi/SPEC.md` has been written and approved.**

## Phase 1: Domain Translation & Map Lookup
1. Check if `.pi/PROJECT_MAP.md` exists in the workspace.
   - **If it exists:** Read `.pi/PROJECT_MAP.md` immediately. Map every human/business term used by the user (e.g., "customer", "invoice", "dashboard", "cancel") to the exact technical classes, database models, and module paths listed in the map.
   - **If it does NOT exist:** Run a fast structural scan using `fd -t d -d 3` and `rg --files | head -n 80` to identify the tech stack, directory layout, and core domain folders, then create `.pi/PROJECT_MAP.md` first.

## Phase 2: Surgical Reconnaissance (Zero Context Bloat)
Do not read entire files to figure out how the codebase works.
1. If you do not know which exact files handle the feature, delegate the search to **a single sequential Scout Subagent** (if `subagent` is available) or use `rg -n`, `ast-grep` (`sg`), or LSP tools (`lsp_symbols`, `lsp_references`) to locate entry points.
2. Once candidate files are identified, inspect **only** their signatures and relevant sections using `read` with `offset` and `limit` (maximum 100 lines per read).
3. Identify existing architectural patterns in the repo:
   - How are validation, auth guards, and error handling implemented in neighboring modules?
   - Which existing helper functions or UI components must be reused instead of reinventing them?

## Phase 3: High-Impact Clarification Gate
Evaluate if the human prompt contains critical business ambiguity (e.g., edge cases, permissions, destructive vs. soft-delete behavior, state persistence).
- **If critical ambiguity exists:** Stop and ask the user **at most 3 concise, non-technical questions**. For every question, provide a recommended default option so the user can simply reply "Yes" or "Use defaults".
- **If the behavior is unambiguous from existing repo conventions:** Proceed directly to Phase 4.

## Phase 4: Synthesize `.pi/SPEC.md`
Create or overwrite `.pi/SPEC.md` using this exact structure:

~~~markdown
# SPEC.md — Active Technical Specification & State Anchor

## 1. Human Requirement (Original Intent)
> [Concise summary of what the user wants from a human/product perspective]

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** [How the feature works technically in 2-3 sentences]
- **Data / Control Flow:** `[Entry/UI] -> [Controller/Route] -> [Service/Domain] -> [Persistence/State]`
- **Acceptance Criteria:**
  1. [Testable criterion 1]
  2. [Testable criterion 2]

## 3. Surgical File Map (Strict Scope Boundary)
- `path/to/fileA.ext` (Lines X–Y: [Exact function/class to modify and why])
- `path/to/fileB.ext` (Lines X–Y: [Exact function/class to modify and why])
- `path/to/testFile.ext` (Lines X–Y: [Unit/integration test to add or update])

## 4. Atomic Execution Checklist
- [ ] **Step 1 (CURRENT):** [Atomic change in 1 file + verification command]
- [ ] **Step 2:** [Atomic change in 1 file + verification command]
- [ ] **Step 3:** [Targeted test execution & regression check]

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** [List unrelated modules or base components that must remain untouched]
- **Known Pitfalls / Failed Approaches:** [Initially empty; updated immediately if any attempt fails during execution]

## 6. Next Immediate Action
- **Target File & Lines:** `path/to/fileA.ext` (Lines X–Y)
- **Next Command:** [Exact `read` or `edit` action to start Step 1]
~~~

## Phase 5: Hand-off to Execution
Once `.pi/SPEC.md` is written, report to the user:
*"I have translated your request into a technical specification in `.pi/SPEC.md`. Should I proceed with Step 1?"*