---
name: context-handover
description: Saves the complete working state, modified files, remaining checklist items, and failed approaches (Negative Knowledge) into .pi/SPEC.md so the session can safely compact or reset via /clear without losing a single detail.
---

# Skill: Context Handover (Lossless State Serialization)

Invoke this skill whenever:
- The user requests a handover, checkpoint, or state save,
- You have completed a major milestone in `.pi/SPEC.md` and context usage is approaching 90k–110k tokens, or
- You are stuck in a debugging loop and need to serialize your findings before a fresh session start.

## Step-by-Step Handover Protocol

### Step 1: Inspect Actual Workspace State
Run a compact Git status check via `bash` so your handover reflects reality on disk:
~~~bash
git status -s && git diff --stat
~~~

### Step 2: Update `.pi/SPEC.md` completely
Edit `.pi/SPEC.md` so that a brand-new agent session with zero chat history can resume your work within 5 seconds:

1. **Section 3 (Surgical File Map):** Ensure every modified or newly discovered file is listed with its exact current line ranges.
2. **Section 4 (Atomic Execution Checklist):**
   - Mark all verified, completed tasks as `[x]`.
   - Mark the exact task to be executed next as `- [ ] **Step N (CURRENT):** ...`.
3. **Section 5 (Negative Knowledge — CRITICAL):**
   - Document **every single failed attempt, rejected library, broken regex, or architectural dead-end** encountered during this session, including *why* it failed.
   - This prevents the post-compaction or post-`/clear` agent from repeating the exact same mistake!
4. **Section 6 (Next Immediate Action):**
   - Write down the exact file path, line numbers (`offset` and `limit`), and verification command that the next session must execute first.

### Step 3: Notify the User
Reply with a concise confirmation:
*"State handover saved to `.pi/SPEC.md`. All progress and negative knowledge are persisted on disk. You can now safely run `/clear` (or `/compact`) and resume with: `Read .pi/SPEC.md and continue at the CURRENT step.`"*