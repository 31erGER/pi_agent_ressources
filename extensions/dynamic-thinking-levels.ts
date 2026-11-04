/**
 * dynamic-thinking-levels.ts — pi extension wiring (runtime).
 *
 * Registers the `/efforts` TUI command to manage the reasoning-effort level
 * array of the *current* LM Studio model:
 *
 *   /efforts               show the current model's shift+Tab level list
 *   /efforts off,low,high  set that model's level list (writes efforts.json)
 *
 * After writing it triggers pi's native provider refresh — the same one that
 * fires at session start, `/model` open, `/lmstudio`, and `/reload` — and
 * swaps the active model object via pi.setModel, guarded so it only fires
 * when the model's option set actually changed (avoiding a spurious
 * model_change transcript entry). No polling, no file watchers: updates
 * happen exactly at the native refresh moments the user specified.
 *
 * Pure logic:    ../projects/dynamic-readoning-levels/dynamic-efforts.ts
 * efforts.json:  ../projects/lmstudio/lmstudio-efforts.ts (shared, unmodified)
 */
import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  PI_LEVELS,
  loadEfforts,
  effortsFileUrl,
} from "../projects/lmstudio/lmstudio-efforts.ts";
import {
  parseLevelsArg,
  applyEffortArray,
  levelsFromModel,
  optionsDiffer,
} from "../projects/dynamic-readoning-levels/dynamic-efforts.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("efforts", {
    description:
      "Show or set the current LM Studio model's toggleable reasoning-effort levels: " +
      "/efforts [comma/space list of: " +
      PI_LEVELS.join(", ") +
      "]",
    handler: async (args, ctx) => {
      const model = ctx.model;
      if (!model || model.provider !== "lmstudio") {
        ctx.ui.notify(
          "Current model is not an LM Studio model — /efforts is a no-op.",
          "warning",
        );
        return;
      }
      const file = effortsFileUrl().pathname;

      // ---- show
      if (!args.trim()) {
        const levels = levelsFromModel(model);
        ctx.ui.notify(
          model.reasoning
            ? `${model.id} — shift+Tab levels: ${levels.join(", ")} (file: ${file})`
            : `${model.id} — not detected as reasoning, fixed to "off" (file: ${file})`,
        );
        return;
      }

      if (!model.reasoning) {
        ctx.ui.notify(
          `${model.id} is not detected as reasoning — effort levels are fixed to "off", nothing to set.`,
          "warning",
        );
        return;
      }

      // ---- set
      const levels = parseLevelsArg(args);
      if (!levels) {
        ctx.ui.notify(
          `Invalid level list "${args}". Use any of: ${PI_LEVELS.join(", ")}`,
          "error",
        );
        return;
      }

      try {
        const fileUrl = effortsFileUrl();
        const data = await loadEfforts(fileUrl);
        data[model.id] = applyEffortArray(data[model.id], levels);
        await writeFile(fileUrl, JSON.stringify(data, null, 2) + "\n", "utf8");

        const result = await ctx.modelRegistry.refresh({
          providers: ["lmstudio"],
          force: true,
          allowNetwork: true,
        });
        if (result.errors.size > 0) {
          const first = result.errors.values().next().value;
          ctx.ui.notify(
            `efforts.json updated, but LM Studio refresh failed: ${first ? first.message : "unknown error"}`,
            "error",
          );
          return;
        }

        const fresh = ctx.modelRegistry.find("lmstudio", model.id);
        if (!fresh) {
          ctx.ui.notify(
            "efforts.json updated, but the model is no longer in the registry.",
            "error",
          );
          return;
        }

        if (optionsDiffer(fresh, model)) {
          // Re-clamps the current thinking level; appends one model_change entry.
          await pi.setModel(fresh);
          ctx.ui.notify(
            `${fresh.id} — shift+Tab levels now: ${levelsFromModel(fresh).join(", ")}`,
          );
        } else {
          ctx.ui.notify(
            `${fresh.id} — no change (shift+Tab levels: ${levelsFromModel(fresh).join(", ")}). ` +
              "If LM Studio is down, the new file applies at the next successful refresh.",
          );
        }
      } catch (err) {
        ctx.ui.notify(
          `Failed to apply /efforts: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
