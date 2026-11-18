/**
 * editor.ts — SpellingEditor: a CustomEditor that delegates to another editor
 * instance and re-styles its rendered output (red underline for misspellings).
 *
 * Why a wrapper (see projects/language-checker/.pi/PLAN.md, section 3):
 *  - pi wires onSubmit/onChange by PROPERTY ASSIGNMENT on the custom editor
 *    AFTER the factory returns. TS forbids overriding a base property with an
 *    accessor (TS2611), so the six callbacks are replaced by accessors at
 *    runtime via Object.defineProperty and proxied to the inner editor.
 *  - pi copies app shortcut handlers via the `actionHandlers` Map (duck-typed)
 *    → we share the inner editor's Map instance.
 *  - every other interaction (input, mouse, render, text, padding, autocomplete,
 *    working-status) is delegated to the inner editor, so typing, paste,
 *    history, autocomplete, Escape/Ctrl-D and app shortcuts keep working.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorComponent, EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { styleLine } from "./highlight.ts";
import { checkWord, loadDictionary } from "./spell.ts";

/**
 * Factory type — structurally identical to pi's own `EditorFactory`
 * (core/extensions/types.d.ts), which types the third argument as the runtime
 * KeybindingsManager object.
 */
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

let dictionary: Set<string> | null = null;

/**
 * Load (once) the bundled English dictionary.
 * On any failure, fall back to an empty set — the checker becomes a no-op
 * instead of crashing the TUI on load.
 */
function getDictionary(): Set<string> {
	if (!dictionary) {
		try {
			dictionary = loadDictionary(fileURLToPath(new URL("./en-words.txt", import.meta.url)));
		} catch {
			dictionary = new Set();
		}
	}
	return dictionary;
}

/** Callbacks that pi assigns on the outer editor after construction. */
type CallbackStore = {
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
};

const PROXIED_CALLBACKS: ReadonlyArray<keyof CallbackStore> = [
	"onSubmit",
	"onChange",
	"onEscape",
	"onCtrlD",
	"onPasteImage",
	"onExtensionShortcut",
];

export class SpellingEditor extends CustomEditor {
	private readonly inner: CustomEditor;
	private enabled = false;
	private readonly _callbackStore: CallbackStore = {};

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, delegates?: EditorFactory) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.inner = delegates
			? (delegates(tui, theme, keybindings) as unknown as CustomEditor)
			: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		// Share the action-handler Map so app shortcuts, escape, ctrl-d and
		// paste-image handlers registered on this instance reach the inner editor.
		this.actionHandlers = this.inner.actionHandlers;
		// Replace the six plain callback properties with accessors that mirror
		// assignments to the inner editor (pi assigns them after construction).
		for (const key of PROXIED_CALLBACKS) {
			Object.defineProperty(this, key, {
				configurable: true,
				enumerable: true,
				get: (): unknown => this._callbackStore[key],
				set: (value: unknown): void => {
					this._callbackStore[key] = value as never;
					if (this.inner) (this.inner as unknown as CallbackStore)[key] = value as never;
				},
			});
		}
	}

	// ── Checker toggle ──

	/** Turn misspelling highlighting on/off. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.invalidate();
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	// ── Delegation: input, rendering, text, appearance ──

	override handleInput(data: string): void {
		this.inner.handleInput(data);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.inner.handleMouse(event);
	}

	override render(width: number): string[] {
		const inner = this.inner;
		// pi sets these on the outer instance after construction.
		if (inner.focused !== this.focused) inner.focused = this.focused;
		if (inner.borderColor !== this.borderColor) inner.borderColor = this.borderColor;
		const lines = inner.render(width);
		if (!this.enabled || lines.length === 0) return lines;
		const dict = getDictionary();
		// checkWord returns true for OK words — styleLine wants the opposite.
		return lines.map((line) => styleLine(line, (word) => !checkWord(word, dict)));
	}

	override setText(text: string): void {
		this.inner.setText(text);
	}

	override getText(): string {
		return this.inner.getText();
	}

	override getExpandedText(): string {
		return this.inner.getExpandedText();
	}

	override invalidate(): void {
		this.inner.invalidate();
	}

	override setPaddingX(paddingX: number): void {
		this.inner.setPaddingX(paddingX);
	}

	override getPaddingX(): number {
		return this.inner.getPaddingX();
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.inner.setAutocompleteProvider(provider);
	}

	override setAutocompleteMaxVisible(maxVisible: number): void {
		this.inner.setAutocompleteMaxVisible(maxVisible);
	}

	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		this.inner.setWorkingStatusIndicator(indicator);
	}
}
