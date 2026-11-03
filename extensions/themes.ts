/**
 * /themes — live-preview theme switcher for pi.
 *
 *  - /themes          -> interactive picker: arrows preview each theme
 *                        instantly, Enter keeps it (persisted), Esc reverts
 *  - /themes <name>   -> switch directly (e.g. /themes mint, /themes system)
 *  - /themes list     -> print all theme names
 *
 * Theme palettes live as plain JSON in
 * ~/.pi/agent/projects/themes/themes/*.json (tweak freely, then /reload).
 * All logic is tested in ~/.pi/agent/projects/themes/test/.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverThemePaths, handleThemesCommand } from "../projects/themes/src/core.ts";

export default function (pi: ExtensionAPI) {
  // Contribute the project theme folder to pi's theme registry.
  pi.on("resources_discover", async (_event, _ctx) => {
    return { themePaths: discoverThemePaths() };
  });

  pi.registerCommand("themes", {
    description: "Switch color theme (live preview: /themes, direct: /themes <name>, /themes list)",
    handler: async (args, ctx) => {
      // ctx is an ExtensionCommandContext: hasUI lives on ctx, the UI on ctx.ui.
      await handleThemesCommand(args, ctx);
    },
  });
}
