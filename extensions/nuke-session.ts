/**
 * nuke-session.ts — pi extension
 *
 * Decide afterwards that a session was a throwaway session:
 *
 *   /nuke       Move the current session file to the trash and continue in a fresh session.
 *   /nuke-exit  Quit pi and move the session file to the trash once pi has stopped writing to it.
 *
 * Nothing is deleted permanently. The file goes to the desktop trash via the `trash` command
 * (Ubuntu package trash-cli), the same mechanism pi uses when you delete a session in /resume.
 * Restore it from the trash in Dolphin or with `trash-restore`.
 * If `trash` is not available, the file is moved to ~/.pi/agent/discarded-sessions/ instead.
 *
 * Only the conversation history is discarded. Files the agent changed in your project,
 * and files such as .pi/PLAN.md or .pi/LOG.md, stay exactly as they are.
 *
 * Install: cp nuke-session.ts ~/.pi/agent/extensions/   (then restart pi or run /reload)
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FALLBACK_DIR = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "discarded-sessions",
);

/**
 * Moves a session file out of pi's session list without destroying it.
 * Returns a short description of where the file went. Throws if the file could not be moved;
 * in that case the file is still in place.
 */
function discardSessionFile(file: string): string {
  // 1. Desktop trash (restorable in Dolphin or with `trash-restore`)
  const result = spawnSync("trash", [file], { encoding: "utf-8" });
  if (result.status === 0 && !existsSync(file)) return "the trash";

  // 2. Fallback: move into ~/.pi/agent/discarded-sessions/ (never delete)
  mkdirSync(FALLBACK_DIR, { recursive: true });
  let target = join(FALLBACK_DIR, basename(file));
  if (existsSync(target)) target = join(FALLBACK_DIR, `${Date.now()}_${basename(file)}`);
  try {
    renameSync(file, target);
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
    // Different filesystem: copy first, remove the original only after the copy succeeded.
    copyFileSync(file, target);
    unlinkSync(file);
  }
  return target;
}

export default function nukeSessionExtension(pi: ExtensionAPI) {
  // Set by /nuke-exit. The file is moved in session_shutdown, i.e. after pi has finished the
  // current run and written its last entry; moving it earlier could let pi recreate the file.
  let discardOnQuit: string | undefined;

  pi.on("session_shutdown", async (event) => {
    if (!discardOnQuit || event.reason !== "quit") return;
    const file = discardOnQuit;
    discardOnQuit = undefined;
    if (!existsSync(file)) return;
    try {
      discardSessionFile(file);
    } catch (err: any) {
      // The UI is shutting down, so report on stderr; the session file is still in place.
      console.error(`[nuke] Could not discard the session, it is still at ${file}: ${err?.message ?? err}`);
    }
  });

  // /nuke -> discard the current session and continue in a fresh one
  pi.registerCommand("nuke", {
    description: "Discard this session: move its file to the trash and start a fresh session",
    handler: async (_args, ctx) => {
      const file = ctx.sessionManager.getSessionFile(); // plain string: still valid after the switch
      await ctx.waitForIdle();

      const result = await ctx.newSession({
        // Runs after the old session is fully closed. Use only this new ctx here:
        // the old command ctx is stale after the switch and throws if used.
        withSession: async (newCtx) => {
          if (!file || !existsSync(file)) {
            newCtx.ui.notify("Fresh session started. The old session was never saved, nothing to discard.", "info");
            return;
          }
          try {
            const where = discardSessionFile(file);
            newCtx.ui.notify(`Fresh session started. The old session was moved to ${where}.`, "info");
          } catch (err: any) {
            newCtx.ui.notify(
              `Fresh session started, but the old session could not be moved and is still at ${file}: ${err?.message ?? err}`,
              "error",
            );
          }
        },
      });

      // Only if the switch was cancelled is the old ctx still valid.
      if (result.cancelled) ctx.ui.notify("Cancelled by another extension. The session was kept.", "warning");
    },
  });

  // /nuke-exit -> quit pi and discard the session file
  pi.registerCommand("nuke-exit", {
    description: "Discard this session: quit pi and move the session file to the trash",
    handler: async (_args, ctx) => {
      const file = ctx.sessionManager.getSessionFile();
      discardOnQuit = file;
      ctx.ui.notify(
        file
          ? "Quitting. The session file goes to the trash as soon as pi has stopped writing to it."
          : "Quitting. This session was never saved, nothing to discard.",
        "info",
      );
      ctx.shutdown(); // deferred until the agent is idle; session_shutdown then moves the file
    },
  });
}
