/**
 * data-guard.ts — pi extension
 *
 * Install:  mkdir -p ~/.pi/agent/extensions && cp data-guard.ts ~/.pi/agent/extensions/
 *           Restart pi; the startup header lists loaded extensions.
 *
 * What it does:
 *   Before the agent runs a bash command, this guard checks it for
 *     - any git command that can change a repository (init, add, commit, stash,
 *       checkout, restore, reset, clean, push, ...), and
 *     - recursive deletion (rm -r, rm -rf, rm --recursive).
 *   Such a command only runs if you confirm it in a dialog.
 *
 * Default is BLOCK:
 *   - you decline or close the dialog        -> blocked
 *   - no interactive UI (print / JSON / RPC) -> blocked
 *   - the dialog cannot be shown (error)     -> blocked
 *   If you overlook the dialog, nothing happens: the agent simply waits.
 *
 * Read-only git commands pass without asking:
 *   status, diff, log, show, ls-files, rev-parse, blame, grep, help, version
 *
 * Limits: the guard only sees commands of pi's bash tool. It is a pattern check,
 * not a sandbox; it errs on the side of asking (e.g. `rg 'git init'` also asks).
 */

const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "grep", "help", "version",
]);

// "git" at the start or after a separator, a quote, "(" , "`" or "/" (e.g. /usr/bin/git),
// followed by optional global options (-C <path>, -c <key=value>, --no-pager, ...) and the subcommand.
const GIT_CALL =
  /(?:^|[\s;&|(`'"\/])git(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*\s+([A-Za-z][\w-]*)/g;

// "rm" at the start or after a separator, then everything up to the next separator.
const RM_CALL = /(?:^|[\s;&|(`'"\/])rm\s+([^;&|\n]*)/g;

/** Returns a reason string if the command needs confirmation, otherwise null. */
export function classify(command: string): string | null {
  for (const m of command.matchAll(GIT_CALL)) {
    const sub = m[1].toLowerCase();
    if (!READ_ONLY_GIT.has(sub)) {
      return `git ${sub} can change a repository or create one`;
    }
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
        `Blocked by data-guard: ${reason}. Do not retry this in another form ` +
        `(no aliases, scripts, sh -c or full paths). Continue without it, or ask the user ` +
        `to run it themselves.`,
    };

    if (ctx?.hasUI === false || typeof ctx?.ui?.confirm !== "function") return blocked;

    try {
      const ok = await ctx.ui.confirm(
        "data-guard",
        `The agent wants to run:\n\n${command}\n\nReason for asking: ${reason}.\nAllow this once?`,
      );
      return ok === true ? undefined : blocked;
    } catch {
      return blocked;
    }
  });
}
