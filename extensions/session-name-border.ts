/**
 * session-name-border
 *
 * Displays the current session name (set via `/name <name>`) on the right
 * side of the colored top line of the chat input field.
 *
 * The label is stuck to the left: the beginning of the name is always shown,
 * the name text is capped at 70 visible characters, and a longer name is
 * truncated with `...` at the end. When no name is set, the built-in top
 * border (including the working spinner and the "↑ N more" scroll indicator)
 * is rendered untouched.
 */
import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { trackExtensionRun } from "./stats.ts"; // global usage counter (stats extension)

/** Maximum visible columns for the name text itself (before the `...`). */
const MAX_NAME_WIDTH = 70;
const ELLIPSIS = "...";
const DASH = "─";

/**
 * Cap the session name at MAX_NAME_WIDTH visible columns. The text is stuck
 * to the left: the beginning of the name is kept, and when it is too long
 * `...` is appended at the end of the truncated name.
 */
function capName(raw: string): string {
	const name = stripTerminalSequences(raw).trim();
	if (visibleWidth(name) <= MAX_NAME_WIDTH) return name;
	return sliceByColumn(name, 0, MAX_NAME_WIDTH) + ELLIPSIS;
}

/**
 * Append the session name label to the right edge of a rendered top-border
 * line.
 *
 * Only the trailing run of `─` in the border is replaced by
 * `<filler> <label> ─`, so built-in content (working spinner on the left,
 * "↑ N more" scroll indicator) is preserved. The label text is stuck to the
 * left: under space pressure the end of the name is truncated first, never
 * the beginning.
 */
function appendSessionName(
	borderLine: string,
	name: string,
	borderColor: (text: string) => string,
): string {
	const totalWidth = visibleWidth(borderLine);
	if (totalWidth <= 0) return borderLine;

	const plain = stripTerminalSequences(borderLine);
	let trailing = 0;
	for (let i = plain.length - 1; i >= 0 && plain[i] === DASH; i--) trailing++;
	// Need at least one dash left to close the border.
	if (trailing <= 1) return borderLine;

	// Columns available for the name text: 2 padding spaces + 1 trailing dash.
	const budget = trailing - 3;
	if (budget <= 0) return borderLine;

	let label = capName(name);
	if (visibleWidth(label) === 0) return borderLine; // whitespace-only name
	if (visibleWidth(label) > budget) {
		// Terminal too narrow for the capped label: re-truncate from the right.
		label =
			budget >= 4 ? sliceByColumn(name, 0, budget - 3) + ELLIPSIS : sliceByColumn(name, 0, budget);
	}

	const zoneWidth = 2 + visibleWidth(label);
	const fillerWidth = trailing - zoneWidth - 1;
	const prefix = sliceByColumn(borderLine, 0, totalWidth - trailing);
	const filler = fillerWidth > 0 ? borderColor(DASH.repeat(fillerWidth)) : "";
	const zone = borderColor(` ${label} `);
	return prefix + filler + zone + borderColor(DASH);
}

class SessionNameEditor extends CustomEditor {
	private readonly getName: () => string | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getName: () => string | undefined,
	) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.getName = getName;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const top = lines[0];
		if (!top) return lines;
		const name = this.getName();
		if (!name) return lines;
		lines[0] = appendSessionName(top, name, this.borderColor);
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		trackExtensionRun(import.meta.url); // /stats global usage counter (one run per session)
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new SessionNameEditor(tui, theme, keybindings, () => ctx.sessionManager.getSessionName()),
		);
	});
}
