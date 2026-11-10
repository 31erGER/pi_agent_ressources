---
name: pi-extension-upgrade-check
description: Verifies that the user-built extensions in ~/.pi/agent/extensions still load and typecheck cleanly after a pi upgrade (new version in ~/.pi/agent/install/releases), and re-points the agent-dir package symlinks to the active release. Use whenever pi was updated (e.g. after "pi update", a new release directory appearing, or the changelog being pasted) and the question is whether the built extensions are affected.
---

# Pi extension upgrade check

After a pi update, prove that the extensions in `~/.pi/agent/extensions/` are unaffected instead of assuming it. pi loads extensions through jiti with **aliases that point into the active release** (`~/.pi/agent/install/releases/<ver>/node_modules/@earendil-works/...`), so type errors never break loading — you must check *both* runtime loading and type compatibility.

Key paths (agent dir = `~/.pi/agent`, override via `PI_CODING_AGENT_DIR`):

- Extensions: `~/.pi/agent/extensions/*.ts`
- Releases: `~/.pi/agent/install/releases/<ver>/node_modules/@earendil-works/{pi-coding-agent,pi-tui}`
- Load test: `~/.pi/agent/bin/pi-ext-loadtest.mjs [version]`
- Editor symlinks: `~/.pi/agent/node_modules/@earendil-works/*` (symlinks into one release; must be re-pointed after an update)
- Extension project suites, if any: `~/.pi/agent/projects/<name>` (e.g. themes has `npm test`)

## Workflow

Run every step; keep command output small (`| head -n 30` / `| tail -n 5`).

### 1. Identify old and new versions

```bash
ls ~/.pi/agent/install/releases/        # all installed versions
pi --version                            # active one
```

### 2. List changed APIs from the changelog

Read the changelog section old→new (GitHub `CHANGELOG.md` or the pasted notes). Extract: **breaking changes** and everything touching extension APIs — `GrepOperations`, `registerMarkdownTransformer`, `ctx.switchSession`, `ctx.ui.custom`/`blocked`, `models.classify`, `defineTool`/tool result types, `Component`/pi-tui classes, `pi auth`, `compat.*` model settings.

### 3. Audit extensions against the changed APIs

```bash
cd ~/.pi/agent/extensions
rg -n "<api1>|<api2>|..." -o | head -30          # only changed APIs from step 2
```

For every hit, open the matched lines and distinguish **pi API usage** from **local implementations with the same name** (e.g. a local `classify()` function is not `models.classify()`). Report each hit as affected / not-affected with a reason.

### 4. Verify imported symbols exist in the new types

Collect every symbol imported from `@earendil-works/pi-*` (`rg -o 'from "@earendil-works/[^"]+"' -N`), then confirm each name appears in the new release's `.d.ts` files. A missing symbol = extension broken.

### 5. Runtime load test (authoritative)

```bash
node ~/.pi/agent/bin/pi-ext-loadtest.mjs          # auto-detects active release
```

It imports every extension through jiti with the same alias map pi's loader uses. Expect `ALL LOADED`, exit 0. This catches import-time breakage; it does **not** check types — step 6 does.

### 6. Typecheck against the new types (and classify errors)

Create `/tmp/ext-tsconfig-<ver>.json` (one per pi version compared), with `paths` mapping both packages to that release's entry types. tsc does **not** expand `~` — substitute the real `$HOME` when writing the file:

```json
{
  "compilerOptions": {
    "noEmit": true, "target": "es2022", "module": "esnext",
    "moduleResolution": "bundler", "allowImportingTsExtensions": true,
    "strict": true, "skipLibCheck": true,
    "baseUrl": "~/.pi/agent",
    "paths": {
      "@earendil-works/pi-coding-agent": ["install/releases/<ver>/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["install/releases/<ver>/node_modules/@earendil-works/pi-tui/dist/index.d.ts"]
    }
  },
  "include": [
    "~/.pi/agent/extensions/**/*.ts"
  ]
}
```

Add any `../projects/...` files the extensions import (see step 3's import scan). Then:

```bash
npx -y -p typescript@5.9.2 tsc -p /tmp/ext-tsconfig-<new>.json 2>&1 | head -n 30
```

Always pin `typescript@5.9.2` — unpinned `npx -p typescript` now resolves to a tsc that removed `baseUrl` (and rejects non-relative `paths`), breaking the template above.

- **0 errors** → done.
- **Errors** → repeat against the **old** release's types and `diff` the error sets (normalize: `grep -E '^[^(]+\.ts' | sort`). Errors present in **both** are pre-existing (jiti strips types, so they are inert); only **new** errors are caused by the upgrade. Fix new ones; with the user's OK, pre-existing ones can be fixed too (they are usually type-level only: `as const` literal narrowing, structural view types for pi-tui private fields, accurate non-generic signatures).

After any fix, re-run the extension's own test suite (e.g. `cd ~/.pi/agent/projects/themes && npm test 2>&1 | tail -n 5`) — baseline first, then post-fix.

### 7. Re-point the editor symlinks

`~/.pi/agent/node_modules/@earendil-works/` holds **symlinks** into one release. Re-point them to the active one (editor typechecking + any non-aliased import resolution):

```bash
NEW=~/.pi/agent/install/releases/<ver>/node_modules/@earendil-works
cd ~/.pi/agent/node_modules/@earendil-works
for p in pi-coding-agent pi-tui; do
  [ -L "$p" ] && rm "$p" && ln -s "$NEW/$p" "$p"
done
ls -la
```

`rm` only removes the link — it never touches the release directory. Only act while `[ -L ]` is true.

### 8. Report

Table with: version pair, each changed API vs. extensions (affected/not), load test result, typecheck results (new vs pre-existing error counts), symlink state, test-suite results. State explicitly whether a restart/reload is needed (type-only changes: no; runtime-affecting changes: yes, `/reload` or new session).

## Safety rules

- Never `rm -r` anything under `install/releases/` (that is pi's installed version).
- Only touch the two `@earendil-works` symlinks in the agent `node_modules`; leave other packages there alone.
- Runtime-verified facts: pi's `ScrollView.child` is `private readonly` in the d.ts but a plain `this.child` field at runtime; a `ScrollView & { child }` intersection collapses to `never` — use a structural view type + one `as unknown as` cast instead.
