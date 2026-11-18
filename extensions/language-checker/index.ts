/**
 * language-checker — pi extension: underline misspelled English words in the
 * main input field (red foreground + underline). Toggle with /spelling.
 *
 * How it works:
 *  - ON by default: on session_start the extension installs a SpellingEditor
 *    factory that wraps whatever editor component is currently installed
 *    (e.g. session-name-border's, or the stock editor) and re-styles its
 *    rendered output.
 *  - The install is deferred by one macrotask: extension session_start
 *    handlers run in ALPHABETICAL extension order (verified in pi 1.5.2
 *    core/extensions/runner.js emit()), so we would run BEFORE
 *    session-name-border and get clobbered by its setEditorComponent.
 *    Deferring guarantees we capture and wrap the LAST installed factory.
 *  - /spelling toggles for the current session. An explicit user choice
 *    (userPref) persists across session switches within the process; after
 *    a process restart the default (ON) applies again.
 *  - Turning OFF restores the captured factory exactly.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SpellingEditor } from "./editor.ts";
import type { EditorFactory } from "./editor.ts";

const ext = (pi: ExtensionAPI): void => {
	// In-memory state: default ON. userPref remembers an explicit /spelling
	// choice so a session switch (resume/fork) does not override the user.
	let enabled = false;
	let userPref: boolean | null = null;
	let previousFactory: EditorFactory | undefined;
	let installedFactory: EditorFactory | undefined;

	const install = (ctx: ExtensionContext): void => {
		const current = ctx.ui.getEditorComponent() ?? undefined;
		// Never wrap ourselves (e.g. session_start fires again while our
		// wrapper is still the installed component): keep the previously
		// captured base as the inner factory.
		const base = current === installedFactory ? previousFactory : current;
		previousFactory = base;
		const factory: EditorFactory = (tui, theme, keybindings) => {
			const editor = new SpellingEditor(tui, theme, keybindings, base);
			editor.setEnabled(true);
			return editor;
		};
		installedFactory = factory;
		enabled = true;
		ctx.ui.setEditorComponent(factory);
	};

	const uninstall = (ctx: ExtensionContext): void => {
		enabled = false;
		installedFactory = undefined;
		const restore = previousFactory;
		previousFactory = undefined;
		ctx.ui.setEditorComponent(restore);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Respect an explicit opt-out; otherwise the default is ON.
		if (userPref === false) return;
		// Defer past all other (alphabetically later) session_start handlers
		// so we wrap the final editor component, not a transient one.
		setTimeout(() => {
			if (userPref === false) return;
			const current = ctx.ui.getEditorComponent() ?? undefined;
			if (current === installedFactory) return; // already active here
			install(ctx);
		}, 0);
	});

	pi.registerCommand("spelling", {
		description: "Toggle red-underline spelling check in the input field (on by default)",
		handler: async (_args: string, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Spelling check can only be toggled in the TUI.", "error");
				return;
			}
			if (!enabled) {
				userPref = true;
				install(ctx);
				ctx.ui.notify("Spelling check ON — misspelled English words are underlined in red in the input.", "info");
			} else {
				userPref = false;
				uninstall(ctx);
				ctx.ui.notify("Spelling check OFF.", "info");
			}
		},
	});
};

export default ext;
