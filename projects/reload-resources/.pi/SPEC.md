# SPEC.md — Active Technical Specification & State Anchor

## 1. Human Requirement (Original Intent)
> When I use `/reload`, Pi prints nothing useful — just a success status line.
> At startup Pi prints a "loaded resources" block (`[Context]`, `[Skills]`,
> `[Prompts]`, `[Extensions]`, plus conflict/issue warnings). I want `/reload`
> to show that same listing after reloading, so I can see what actually loaded.

## 2. Technical Architecture & Data Flow
- **Display mechanism:** a **custom session entry** (not an LLM message):
  - `pi.registerEntryRenderer("reload-resources", …)` — themed TUI component
    mirroring the built-in startup block (compact comma lists; scope-grouped
    lists when the transcript expansion state is on).
  - On `session_start` with `reason === "reload"` → collect data →
    `pi.appendEntry("reload-resources", data)`.
  - The TUI renders the entry **live** on the `entry_appended` event
    (`addCustomEntryToChat`, `interactive-mode.js:2741`) and re-renders it
    from the session file on chat rebuild/resume (`renderSessionItems`,
    `interactive-mode.js:3205`).
  - Custom entries are persisted in the session JSONL and **never enter LLM
    context** (docs + `registerEntryRenderer` JSDoc confirm this).
- **Why this shape:** the built-in block is rendered into
  `loadedResourcesContainer` at the **top** of the scrollback
  (`documentContainer`: header → loadedResources → chat). After a reload mid
  conversation it is re-rendered there — off-screen. An entry appended at the
  end of the session lands exactly where the user is looking (bottom of
  chat), and is the documented, durable, context-safe channel.
- **Data / Control Flow:**
  ```
  /reload → InteractiveMode.handleReloadCommand()
          → session.runtime.reload() (new extension runner, resources reloaded)
          → emit("session_start", { reason: "reload" })
          → extension handler: collect → pi.appendEntry
          → session persists custom entry, emits entry_appended
          → TUI addCustomEntryToChat → registered renderer → block at bottom
  ```
- **Collection sources (display-only — nothing is executed by this extension):**
  - skills + skill diagnostics: exported `loadSkills({cwd, agentDir,
    skillPaths: [], includeDefaults: true})` — the same exported discovery
    routine over default user (`<agentDir>/skills`) + project
    (`<cwd>/.pi/skills`) dirs.
  - context files: exported `loadProjectContextFiles({cwd, agentDir})`
    (AGENTS.md / CLAUDE.md etc.).
  - prompts: `pi.getCommands().filter(c => c.source === "prompt")`
    (session-accurate; names + `sourceInfo`).
  - extensions: mirror of the core loader's path discovery
    (`loader.js:635-700`): `<cwd>/.pi/extensions` → `<agentDir>/extensions` →
    settings `extensions[]` (dir ⇒ package.json `pi.extensions` manifest,
    else `index.ts`/`index.js`, else file scan; files as-is), deduped by
    resolved path; **non-existent paths skipped** (the core would report them
    as load errors anyway).
- **Label/formatting parity** (mirrors `interactive-mode.js`):
  - section header `theme.fg("mdHeading", "[Name]")`; compact list
    `theme.fg("dim", "  a, b, c")` sorted (Context unsorted).
  - Context: cwd-relative if under cwd, else `~`-prefixed.
  - Extensions: shortest-unique-suffix of `~`-prefixed display segments,
    trailing `index.ts`/`index.js` popped (mirrors
    `getCompactExtensionLabels`).
  - Expanded: per-scope groups `project` → `user` → `path`, scope line
    `theme.fg("accent", scope)`, paths dim (mirrors `formatScopeGroups`).
  - Diagnostics: `[Skill conflicts]` warning block, collisions grouped by
    name with ✓ winner / ✗ loser (skipped) (mirrors `formatDiagnostics`).

## 3. File & Code Map
| File | Role |
| --- | --- |
| `~/.pi/agent/extensions/reload-resources.ts` | **The extension** (single file, auto-discovered from the global extensions dir). Factory registers entry renderer + `session_start` handler. |
| `~/.pi/agent/projects/reload-resources/.pi/SPEC.md` | This spec. |
| (read-only refs) `dist/core/extensions/loader.js:584-700` | Core extension path discovery mirrored for the listing. |
| (read-only refs) `dist/modes/interactive/interactive-mode.js:1049,1210-1262,1327-1470` | Built-in startup block formatting mirrored. |
| (read-only refs) `dist/core/skills.ts`, `resource-loader.ts` | Exported `loadSkills`, `loadProjectContextFiles`. |
| (read-only refs) `examples/extensions/entry-renderer.ts` | Official custom-entry pattern. |

## 4. Execution Checklist
- [x] 1. Verify custom-entry render pipeline (live + rebuild paths) — done.
- [x] 2. Verify discovery APIs exported & `SessionStartEvent.reason` — done.
- [x] 3. Write `~/.pi/agent/extensions/reload-resources.ts`.
- [x] 4. Verified by loading with pi's own jiti loader (same aliases as `loader.js`): module loads, factory registers, all runtime property accesses exercised against real pi exports (`loadSkills`, `loadProjectContextFiles`, `getAgentDir`). No TypeScript compiler available in this environment; all used API shapes cross-checked manually against the package `.d.ts` files (see Decision Log).
- [x] 5. Simulated end-to-end with stubbed ExtensionAPI: `startup`/`new`/non-tui → no entry; tui `reload` → entry appended; collapsed + expanded rendering match the built-in layout; failures in discovery are swallowed (never breaks /reload). TUI event wiring confirmed in source (`entry_appended` → `addCustomEntryToChat` live; `renderSessionItems` on rebuild; TUI subscription persists across reloads).
- [x] 6. This file updated.
- [ ] 7. (user) Optional real-TUI confirmation: run `/reload` once — expect the block at the bottom of the transcript.

## 5. Constraints & Invariants
- **Must not** send anything to the LLM (custom entry only; never
  `sendMessage`).
- **Must not** break `/reload` if discovery fails — handler is wrapped in
  try/catch and returns silently.
- **Must not** execute/load extensions or skills (read-only fs discovery).
- Guard: only append when `ctx.mode === "tui"` (non-TUI modes never render
  entries) and only when `event.reason === "reload"`.
- Do not duplicate the startup block: reason `"startup"` must NOT append
  (the built-in block already shows at startup).
- Single file, no new runtime dependencies (node builtins + the two pi
  packages already available to extensions).
- Entry data is versioned (`v: 1`) so future schema changes can be ignored by
  the renderer.

## 6. Verification & Test Plan
1. `npx tsc --noEmit` (or jiti transpile) — no type/syntax errors.
2. In TUI: run `/reload` → expect a block like:
   ```
   [Context]
     AGENTS.md
   [Skills]
     context-handover, extension-creator, quiet-verifier, subagent-orchestrator, surgical-reader, vibe-to-spec
   [Extensions]
     lmstudio.ts, notify-on-settle.ts, reload-resources.ts, token-counter.ts
   ```
   (Prompts section only if prompt templates exist.)
3. Inspect the session JSONL: one `{"type":"custom","customType":"reload-resources",…}` line per `/reload`; no `message` entries added.
4. `/new` / resume → no new entry from this extension on startup reasons.
5. Send a follow-up prompt after `/reload` → model does not reference the
   listing (it is not in its context).

## 7. Handover & State Anchor
- **Last completed step:** 2 (all API verification).
- **Next step:** 3 (write the extension file).
- **Current file state:** extension not yet written; no other files touched.
- **Environment notes:** pi 1.4.0 at
  `/home/julian/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent`.
  User's global skills: 6 in `~/.pi/agent/skills`; extensions in
  `~/.pi/agent/extensions` (lmstudio, notify-on-settle, token-counter).
  `settings.json` has a dead `extensions` entry
  (`/home/julian/.pi/projects/audio-notification/notify-on-settle.ts` — path
  does not exist; the real file loads via dir discovery). The listing skips
  non-existent configured paths by design.

## 8. Decision Log & Negative Knowledge
- **DECIDED:** custom session entry (`appendEntry` + `registerEntryRenderer`)
  over alternatives:
  - `sendMessage` — rejected: custom messages are converted into LLM context.
  - `ctx.ui.setStatus`/notify — rejected: transient, not a "print", vanishes
    immediately.
  - Registering a `/reload` override — rejected: `/reload` is a built-in
    handled by InteractiveMode, not a replaceable extension command; and
    re-implementing reload would duplicate core behavior.
- **DECIDED:** skills via exported `loadSkills()` (not the live session
  `resourceLoader`, which is not exposed to extensions). Known gap:
  skills added by package managers or `resources_discover` handlers are not
  listed. Accepted: user's setup only uses default dirs.
- **DECIDED:** skip `[Themes]` and `[Extension issues]` sections — the
  loader's diagnostics/error state is not reachable from an extension API.
  Skill conflicts (from `loadSkills` diagnostics) ARE shown.
- **NEGATIVE:** no `ThemedText` export in `@earendil-works/pi-tui` — use
  plain `Text` with theme baked in at render time (same as the official
  entry-renderer example). Theme changes after render do not recolor the
  entry; accepted.
- **NEGATIVE:** `pi.getCommands()` returns `SlashCommandInfo`
  (`{name, description?, source: "extension"|"prompt"|"skill", sourceInfo}`) —
  filter on `source === "prompt"`; the file path is `sourceInfo.path`.
- **NEGATIVE:** `SourceScope` is `"user" | "project" | "temporary"`; the
  display groups are `project | user | path` — map via the same rules as
  `InteractiveMode.getScopeGroup` (source "cli" or scope "temporary" → "path").
- **NOTE:** `registerEntryRenderer` renderer gets `{ expanded }` from the
  transcript expansion state (tool output expanded toggle / verbose), matching
  the startup block's `getStartupExpansionState()`.
- **BUG FOUND IN TESTING:** a naive "under `<cwd>/.pi` ⇒ project" scope rule
  mislabels `~/.pi/agent/extensions/*` as project when cwd is the home dir
  (agent dir is a subdir of `~/.pi`). The core (resource-loader.js ~755) checks
  AGENT roots BEFORE project roots; `extensionScope()` mirrors that exact order.
- **NOTE:** long compact lists word-wrap — identical to the built-in, because
  its `ThemedText extends Text` (pi-tui `Text` wraps). Parity, not a bug.
- **NOTE:** the extension lists itself (`reload-resources.ts`) in its own
  Extensions section — correct, it really is loaded.
