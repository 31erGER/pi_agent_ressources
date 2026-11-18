/**
 * Runtime smoke test: exercises SpellingEditor through the exact wiring
 * sequence pi's setCustomEditorComponent performs (interactive-mode.js 1.5.2):
 *
 *   1. factory(tui, theme, keybindings) → editor instance
 *   2. newEditor.onSubmit / onChange = defaultEditor's callbacks
 *   3. newEditor.setText(currentText)
 *   4. newEditor.borderColor = defaultEditor.borderColor (if defined)
 *   5. setPaddingX / setAutocompleteMaxVisible / setAutocompleteProvider (if present)
 *   6. duck-typed CustomEditor block: onEscape/onCtrlD/onPasteImage/
 *      onExtensionShortcut (if unset) + actionHandlers Map copy
 *   7. setWorkingStatusIndicator (duck-typed)
 *   8. ui.setFocus(editor) → editor.focused = true
 *
 * Uses the REAL CustomEditor class (from the pi release) for both the previous
 * editor and the inner editor, with stub tui/theme/keybindings.
 *
 * Run: node --test /home/julian/.pi/agent/projects/language-checker/test/smoke.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { SpellingEditor } from "../../../extensions/language-checker/editor.ts";

// Minimal stubs — the Editor constructor only stores these; render uses the
// theme's borderColor function and the tui's requestRender.
const tui = new Proxy(
	{ terminal: { rows: 40, columns: 80 } },
	{
		get: (t, prop) =>
			prop in t ? (t as Record<PropertyKey, unknown>)[prop] : (prop === Symbol.toPrimitive ? () => 80 : () => undefined),
		set: () => true,
	},
) as unknown as TUI;

const theme = {
	borderColor: (text: string) => text,
	selectList: {},
} as unknown as EditorTheme;

// No-op keybinding manager: matches() must exist (CustomEditor.handleInput
// calls it) and return false so no key is consumed by app shortcuts.
const keybindings = { matches: () => false };

function makePreviousEditor() {
	return new CustomEditor(tui, theme, keybindings as never, { embedWorkingStatus: true });
}

test("pi wiring sequence end-to-end (real CustomEditor inside)", () => {
	// ── Step 1: factory (what index.ts installs) ──
	const prevFactory = (_t: TUI, _th: EditorTheme, _kb: never) => makePreviousEditor();
	let wrapper: SpellingEditor | null = null;
	const factory = (_t: TUI, _th: EditorTheme, _kb: never) => {
		wrapper = new SpellingEditor(tui, theme, keybindings as never, prevFactory as never);
		wrapper.setEnabled(true);
		return wrapper;
	};
	const editor = factory(tui, theme, keybindings as never)!;

	// ── Steps 2+3: callbacks + text (pi assigns after factory returns) ──
	const submitted: string[] = [];
	let changeCount = 0;
	editor.onSubmit = (text: string) => void submitted.push(text);
	editor.onChange = () => void changeCount++;
	editor.setText("please recieve the package");

	// ── Steps 4-7: appearance + duck-typed block ──
	if (editor.borderColor !== undefined) editor.borderColor = makePreviousEditor().borderColor;
	if (editor.setPaddingX !== undefined) editor.setPaddingX(0);
	if (editor.setAutocompleteMaxVisible !== undefined) editor.setAutocompleteMaxVisible(5);
	const inner = (editor as unknown as { inner: CustomEditor }).inner;
	if (!editor.onEscape) editor.onEscape = () => undefined;
	if (!editor.onCtrlD) editor.onCtrlD = () => undefined;
	if (!editor.onPasteImage) editor.onPasteImage = () => undefined;
	// Real onExtensionShortcut returns true only for registered extension
	// shortcut sequences — for plain typing it must return false.
	if (!editor.onExtensionShortcut) editor.onExtensionShortcut = () => false;
	const actionHandlers = new Map<string, () => void>();
	actionHandlers.set("app.clear", () => undefined);
	for (const [action, handler] of actionHandlers) inner.actionHandlers.set(action as never, handler);
	if (typeof (editor as { setWorkingStatusIndicator?: unknown }).setWorkingStatusIndicator === "function") {
		(editor as unknown as { setWorkingStatusIndicator(i: undefined): void }).setWorkingStatusIndicator(undefined);
	}
	// ── Step 8: focus ──
	(editor as { focused: boolean }).focused = true;

	// ── Assertions ──
	assert.ok(editor instanceof SpellingEditor, "factory returned the SpellingEditor");

	// Callbacks proxied to the inner editor (the one that actually handles input).
	assert.equal(
		inner.onSubmit,
		(editor as { onSubmit?: unknown }).onSubmit,
		"onSubmit mirrored on inner (same reference, via wrapper accessor)",
	);
	assert.equal(
		inner.onChange,
		(editor as { onChange?: unknown }).onChange,
		"onChange mirrored on inner",
	);
	assert.ok(inner.onEscape, "onEscape proxied to inner");
	assert.ok(inner.onCtrlD, "onCtrlD proxied to inner");
	assert.ok(inner.onPasteImage, "onPasteImage proxied to inner");
	assert.ok(inner.onExtensionShortcut, "onExtensionShortcut proxied to inner");
	assert.equal(inner.onSubmit, (editor as { onSubmit?: unknown }).onSubmit, "onSubmit mirrored on inner");

	// actionHandlers shared, so app shortcuts reach the inner editor.
	assert.equal(inner.actionHandlers, editor.actionHandlers);
	assert.ok(editor.actionHandlers.has("app.clear" as never), "action handler copied into shared map");

	// Text flows through the wrapper into the inner editor.
	assert.equal(editor.getText(), "please recieve the package");
	assert.equal(inner.getText(), "please recieve the package");

	// Rendering: misspelled word gets red + underline; the rest is untouched.
	const lines = editor.render(80);
	assert.ok(Array.isArray(lines) && lines.length > 0, "render produced lines");
	const joined = lines.join("\n");
	assert.ok(joined.includes("\x1b[31;4mrecieve"), "recieve wrapped in red+underline");
	assert.ok(joined.includes("\x1b[24m"), "underline restored");
	assert.ok(joined.includes("please") && joined.includes("the package"));

	// Toggling off stops the styling (inner editor output passes through raw).
	editor.setEnabled(false);
	const plain = editor.render(80).join("\n");
	assert.ok(!plain.includes("\x1b[31;4m"), "no red underline when disabled");

	// Input reaches the inner editor (typing changes the text).
	const before = editor.getText();
	editor.handleInput("x");
	assert.ok(editor.getText().includes("x"), "typed char reached inner editor");
	assert.notEqual(editor.getText(), before);

	// getExpandedText delegation (used by pi when switching editors).
	assert.ok(typeof editor.getExpandedText() === "string" && editor.getExpandedText().length > 0);
});
