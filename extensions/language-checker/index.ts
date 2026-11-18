/**
 * language-checker — pi extension: underline misspelled English words in the
 * main input field (red foreground + underline). Toggle with /spelling.
 *
 * How it works:
 *  - /spelling ON: captures the currently installed custom editor factory
 *    (e.g. session-name-border's, or undefined for the stock editor), installs
 *    a SpellingEditor factory that delegates to the previous editor and
 *    re-styles its rendered output.
 *  - /spelling OFF: restores the captured factory exactly.
 *  - State is in-memory only: default OFF after restart or extension reload.
 *
 * Installation is done ONLY from the /spelling command — never on
 * session_start — so we never fight other extensions (session-name-border)
 * over the editor slot via load order.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SpellingEditor } from "./editor.ts";
import type { EditorFactory } from "./editor.ts";

const ext = (pi: ExtensionAPI): void => {
	// In-memory state only: default OFF after restart / reload.
	let enabled = false;
	let previousFactory: EditorFactory | undefined;

	pi.registerCommand("spelling", {
		description: "Toggle red-underline spelling check in the input field",
		handler: async (_args: string, ctx) => {
			if (!enabled) {
				// Capture the currently installed custom editor factory and wrap
				// it; restoring it on OFF brings the previous behavior back exactly.
				previousFactory = ctx.ui.getEditorComponent() ?? undefined;
				const prev = previousFactory;
				enabled = true;
				ctx.ui.setEditorComponent((tui, theme, keybindings) => {
					const editor = new SpellingEditor(tui, theme, keybindings, prev);
					editor.setEnabled(true);
					return editor;
				});
				ctx.ui.notify("Spelling check ON — misspelled English words are underlined in red in the input.", "info");
			} else {
				enabled = false;
				const restore = previousFactory;
				previousFactory = undefined;
				ctx.ui.setEditorComponent(restore);
				ctx.ui.notify("Spelling check OFF.", "info");
			}
		},
	});
};

export default ext;
