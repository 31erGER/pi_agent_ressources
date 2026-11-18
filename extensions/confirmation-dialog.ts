/**
 * confirmation-dialog.ts — pi extension
 *
 * Install:  mkdir -p ~/.pi/agent/extensions && cp confirmation-dialog.ts ~/.pi/agent/extensions/
 *           Restart pi; the startup header lists loaded extensions.
 *
 * What it does:
 *   Before the agent runs a bash command, this extension checks it for
 *     - git commands that can DESTROY WORK (uncommitted changes, untracked files,
 *       commits, branches, remote history; list below), and
 *     - recursive deletion (rm -r, rm -rf, rm --recursive).
 *   Such a command only runs if you confirm it in a dialog.
 *   Everything else passes without asking, including git add, commit, init, clone,
 *   merge, pull, fetch, cherry-pick, revert and a plain push (no force).
 *
 *   The dialog rings the notification bell the moment it pops up, so you
 *   know when the session is waiting for you — in addition to the bell at
 *   turn end. The bell is the shared chime() from notify-on-settle.ts
 *   (dependency: keep that file, or the gate will not load).
 *   In print/JSON mode no dialog (and no bell) is possible; the command is
 *   blocked instead.
 *
 * Default is BLOCK:
 *   - you decline or close the dialog        -> blocked
 *   - no dialog possible (print / JSON mode) -> blocked
 *   - the dialog fails with an error         -> blocked
 *   There is no timer: if you are away, the agent waits until you answer, and nothing runs meanwhile.
 *
 * Git commands that ask (data-loss risk). Edit gitReason() to add or remove entries:
 *   reset --hard                          throws away uncommitted changes
 *   clean (unless -n / --dry-run)         deletes untracked files for good
 *   checkout (except -b)                  can overwrite files / discard changes;
 *                                         `git switch <branch>` changes branches without asking
 *   restore (unless --staged only)        overwrites files in the working tree
 *   switch -f / --discard-changes / -C    discards changes or resets a branch
 *   stash drop | clear                    deletes stashed work
 *   push --force[-with-lease] / --delete / --mirror / --prune / +ref / :ref
 *   branch -D / -M / -f, tag -f           deletes or moves refs
 *   rebase, commit --amend                rewrite history
 *   rm -f, mv -f, worktree / submodule / checkout-index with --force
 *   reflog expire|delete, gc --prune=now, prune, update-ref -d, filter-branch, filter-repo
 *
 * How it matches: every `git [global options] <subcommand> <args up to the next ; & | or newline>`
 * is looked at wherever it appears, even inside quotes, `$( )` or after `xargs`/`sudo`. Prose such as
 * `echo "no git repository"` is harmless because "repository" is not on the list above.
 *
 * Limits: the extension only sees commands of pi's bash tool. It is a pattern check,
 * not a sandbox; it errs on the side of asking (e.g. `echo "git reset --hard"` also asks).
 * It does NOT know your git aliases: `git co -- .` (alias for checkout) or a custom
 * `git nuke` passes. Add such names to gitReason() if you use them.
 */

import { chime as bell } from "./notify-on-settle.ts";
import { trackExtensionRun } from "./stats.ts"; // global usage counter (stats extension)

// Test seam: replace the bell in unit tests (keeps the suite silent).
// Pass null to restore the real chime from notify-on-settle.ts.
let ringBell: () => void = bell;
export function setChime(fn: (() => void) | null): void {
  ringBell = fn ?? bell;
}

// One argument: a "double quoted" or 'single quoted' string, or a run of non-blanks.
const ARG = /(?:"[^"]*"|'[^']*'|\S+)/.source;

// Global options that may stand between "git" and the subcommand:
//   -C <path>, -c <key=value>, --git-dir=<p> / --git-dir <p> (also --work-tree, ...), --no-pager, ...
const GLOBAL_OPT =
  "(?:-[Cc]\\s+" + ARG +
  "|--(?:git-dir|work-tree|namespace|config-env|exec-path|super-prefix)(?:=|\\s+)" + ARG +
  "|--?[A-Za-z][\\w-]*(?:=\\S+)?)";

// "git" at the start or after a blank, separator, quote, "(" , "`" or "/" (e.g. /usr/bin/git),
// then global options, then the subcommand (group 1). Group 2 is the rest of the line up to the
// next ; & | or newline; it sits in a lookahead so a nested `$(git ...)` in it is still found.
const GIT_CALL = new RegExp(
  "(?:^|[\\s;&|(`'\"/])git(?:\\s+" + GLOBAL_OPT + ")*\\s+([A-Za-z][\\w-]*)(?=([^;&|\\n]*))",
  "g",
);

// "rm" at the start or after a separator, then everything up to the next separator.
const RM_CALL = /(?:^|[\s;&|(`'"\/])rm\s+([^;&|\n]*)/g;

// --force, --force-with-lease[=...], --force-if-includes, or a short cluster containing f (-f, -fd, -uf).
const FORCE = /^(?:--force(?:-[\w-]+)?(?:=\S*)?|-[A-Za-z]*f[A-Za-z]*)$/;

// A short-option cluster (-n, -nd, -fdx) that contains one of the given letters.
const hasShort = (args: string[], letters: string): boolean =>
  args.some((a) => new RegExp(`^-[A-Za-z]*[${letters}][A-Za-z]*$`).test(a));

/** Reason why `git <sub> <args>` can lose data, or null if it cannot (as far as we can tell). */
function gitReason(sub: string, args: string[]): string | null {
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));
  const forced = args.some((a) => FORCE.test(a));

  switch (sub) {
    case "reset":
      return has("--hard") ? "git reset --hard throws away uncommitted changes" : null;

    case "clean":
      return has("--dry-run") || hasShort(args, "n")
        ? null
        : "git clean deletes untracked files for good";

    case "checkout":
      if (forced) return "git checkout --force discards local changes";
      return args[0] === "-b" || has("--help")
        ? null
        : "git checkout can overwrite files and discard uncommitted changes " +
            "(git switch <branch> changes branches without that risk)";

    case "switch":
      return forced || has("--discard-changes", "-C", "--force-create")
        ? "git switch with force discards local changes or resets a branch"
        : null;

    case "restore": {
      const staged = has("--staged") || hasShort(args, "S");
      const worktree = has("--worktree") || hasShort(args, "W");
      return staged && !worktree ? null : "git restore overwrites files in the working tree";
    }

    case "stash":
      return args[0] === "drop" || args[0] === "clear" ? `git stash ${args[0]} deletes stashed work` : null;

    case "push":
      return forced ||
        has("--delete", "--mirror", "--prune") ||
        hasShort(args, "d") ||
        args.some((a) => a.startsWith("+") || a.startsWith(":"))
        ? "git push can overwrite or delete remote history"
        : null;

    case "branch":
      return forced || hasShort(args, "DM")
        ? "git branch -D / -M / -f deletes or moves a branch"
        : null;

    case "tag":
      return forced ? "git tag -f overwrites a tag" : null;

    case "rm":
      return forced && !has("--cached") ? "git rm --force deletes modified files" : null;

    case "mv":
    case "worktree":
    case "submodule":
    case "checkout-index":
      return forced ? `git ${sub} --force can overwrite or delete local files` : null;

    case "commit":
      return has("--amend") ? "git commit --amend rewrites the last commit" : null;

    case "rebase":
      return "git rebase rewrites history";

    case "reflog":
      return args[0] === "expire" || args[0] === "delete"
        ? `git reflog ${args[0]} removes the safety net for lost commits`
        : null;

    case "gc":
      return has("--prune=now") ? "git gc --prune=now deletes unreachable commits for good" : null;

    case "update-ref":
      return has("-d", "--delete") ? "git update-ref -d deletes a ref" : null;

    case "prune":
    case "filter-branch":
    case "filter-repo":
      return `git ${sub} deletes or rewrites history`;

    default:
      return null;
  }
}

/** Returns a reason string if the command needs confirmation, otherwise null. */
export function classify(command: string): string | null {
  for (const m of command.matchAll(GIT_CALL)) {
    const sub = m[1].toLowerCase();
    // Split the rest of the line into words; strip quotes and brackets glued to them: `--hard)` -> `--hard`.
    const args = m[2]
      .split(/\s+/)
      .map((t) => t.replace(/^["'`({]+|["'`)}]+$/g, ""))
      .filter(Boolean);
    const reason = gitReason(sub, args);
    if (reason) return reason;
  }
  for (const m of command.matchAll(RM_CALL)) {
    const args = m[1].split(/\s+/);
    if (args.some((a) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a) || a === "--recursive")) {
      return "rm with a recursive flag deletes whole directories";
    }
  }
  return null;
}

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event?.toolName !== "bash") return;
    const command = String(event?.input?.command ?? "");
    const reason = classify(command);
    if (!reason) return;

    const blocked = {
      block: true,
      reason:
        `Blocked by confirmation-dialog: ${reason}. Do not retry this in another form ` +
        `(no aliases, scripts, sh -c or full paths). Continue without it, or ask the user ` +
        `to run it themselves.`,
    };

    if (ctx?.hasUI === false || typeof ctx?.ui?.confirm !== "function") return blocked;

    try {
      ringBell(); // bell at the moment the dialog pops up (notify-on-settle.ts)
    } catch {
      // a broken bell must never keep the dialog (or the gate) from working
    }

    try {
      // v1.6 self-report: event-driven extension (no slash command), so the
      // global command tracker in stats.ts can't see it — one count per dialog.
      trackExtensionRun(import.meta.url);
      const ok = await ctx.ui.confirm(
        "confirmation-dialog",
        `The agent wants to run:\n\n${command}\n\nReason for asking: ${reason}.\nAllow this once?`,
      );
      return ok === true ? undefined : blocked;
    } catch {
      return blocked;
    }
  });
}
