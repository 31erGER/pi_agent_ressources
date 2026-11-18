/**
 * Contract tests for index.ts (the extension entry):
 *
 *   - Default ON: on session_start the checker wraps whatever editor
 *     component is installed — including one installed by a LATER
 *     extension (session-name-border runs after us alphabetically).
 *   - /spelling OFF restores the captured factory exactly; ON re-wraps.
 *   - An explicit user choice (OFF) persists across simulated session
 *     switches within the process; a fresh module ("restart") defaults
 *     to ON again.
 *
 * The harness simulates pi's extension runtime: `emit()` calls the
 * session_start handlers in alphabetical extension order (verified in
 * pi 1.5.2 core/extensions/runner.js), then a fake "border" extension
 * installs its editor. Deferred installs are flushed with a timer.
 *
 * Run: node --test /home/julian/.pi/agent/projects/language-checker/test/index.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { SpellingEditor } from "../../../extensions/language-checker/editor.ts";

// ── Shared stubs (same shape as smoke.test.ts) ─────────────────────────────
const tui = new Proxy(
	{ terminal: { rows: 40, columns: 80 } },
	{
		get: (t, prop) =>
			prop in t ? (t as Record<PropertyKey, unknown>)[prop] : () => undefined,
		set: () => true,
	},
) as unknown as TUI;

const theme = {
	borderColor: (text: string) => text,
	selectList: {},
} as unknown as EditorTheme;

const keybindings = { matches: () => false };

/** Fake "previous" editor factory standing in for session-name-border. */
const borderFactory = (_t: unknown, _th: unknown, _kb: unknown): object =>
	new CustomEditor(tui, theme, keybindings as never, { embedWorkingStatus: true });

type AnyFactory = typeof borderFactory;

/** Loads a FRESH module instance of index.ts (query = module-cache bust). */
async function loadExtension(tag: string): Promise<(pi: ExtensionAPI) => void> {
	const url = pathToFileURL(
		new URL("../../../extensions/language-checker/index.ts", import.meta.url).pathname,
	);
	const mod = await import(`${url.href}?${tag}`);
	return mod.default;
}

interface Harness {
	current: () => AnyFactory | undefined;
	setBorder: () => void;
	notifyLog: string[];
	/** Simulate pi's emit("session_start") + the border extension, in order. */
	startSession: () => Promise<void>;
	toggle: () => Promise<void>;
}

function runExtension(extDefault: (pi: ExtensionAPI) => void): Harness {
	const sessionStart: Array<(event: unknown, ctx: ExtensionContext) => void> = [];
	let spellingHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const notifyLog: string[] = [];

	const pi: unknown = {
		registerCommand: (_name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			spellingHandler = def.handler;
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			if (event === "session_start") sessionStart.push(handler);
		},
	};

	let current: AnyFactory | undefined;
	const ctxStub = {
		mode: "tui",
		ui: {
			setEditorComponent: (f: AnyFactory | undefined) => {
				current = f;
			},
			getEditorComponent: () => current,
			notify: (msg: string) => {
				notifyLog.push(msg);
			},
		},
	};
	const ctx = ctxStub as unknown as ExtensionContext;

	extDefault(pi as ExtensionAPI);

	const startSession = async (): Promise<void> => {
		// pi's emit(): handlers in alphabetical extension order (us first,
		// "session-name-border" second). Each handler is awaited.
		for (const handler of sessionStart) {
			await handler({ type: "session_start", reason: "new" }, ctx);
		}
		// The fake border extension installs its editor synchronously.
		ctxStub.ui.setEditorComponent(borderFactory);
		// Flush any deferred (macrotask) installs.
		await new Promise((r) => setTimeout(r, 20));
	};

	return {
		current: () => current,
		setBorder: () => ctxStub.ui.setEditorComponent(borderFactory),
		notifyLog,
		startSession,
		toggle: async () => {
			assert.ok(spellingHandler, "/spelling command is registered");
			await spellingHandler("", ctx);
		},
	};
}

const innerOf = (editor: object): CustomEditor =>
	(editor as { inner: CustomEditor }).inner;

test("default ON: session_start wraps the editor installed by a later extension", async () => {
	const extDefault = await loadExtension("default-on");
	const h = runExtension(extDefault);

	await h.startSession();

	const factory = h.current();
	assert.ok(factory, "an editor component is installed after session start");
	assert.notEqual(factory, borderFactory, "our wrapper replaced the raw border factory");

	const editor = factory!(tui, theme, keybindings as never);
	assert.ok(editor instanceof SpellingEditor, "installed editor is a SpellingEditor");
	assert.ok(innerOf(editor) instanceof CustomEditor, "inner editor is the border's CustomEditor");
	assert.equal(h.notifyLog.length, 0, "default enable is silent (no startup notification spam)");
});

test("/spelling OFF restores the captured factory; ON re-wraps it", async () => {
	const extDefault = await loadExtension("toggle");
	const h = runExtension(extDefault);

	await h.startSession();
	assert.notEqual(h.current(), borderFactory, "wrapped after start");

	await h.toggle(); // OFF
	assert.equal(h.current(), borderFactory, "OFF restores the border factory exactly");

	await h.toggle(); // ON again
	assert.notEqual(h.current(), borderFactory, "ON re-wraps");
	const editor = h.current()!(tui, theme, keybindings as never);
	assert.ok(editor instanceof SpellingEditor, "re-wrapped editor is a SpellingEditor");
	assert.ok(innerOf(editor) instanceof CustomEditor, "inner is a fresh border editor");
});

test("explicit OFF persists across simulated session switches", async () => {
	const extDefault = await loadExtension("persist-off");
	const h = runExtension(extDefault);

	await h.startSession();
	await h.toggle(); // user opts out
	assert.equal(h.current(), borderFactory, "off after explicit toggle");

	// A new session (resume/fork): the border extension re-installs, our
	// session_start handler runs again — but the user's choice holds.
	await h.startSession();
	assert.equal(h.current(), borderFactory, "stays off across session switches");

	// …until the user opts back in.
	await h.toggle();
	assert.notEqual(h.current(), borderFactory, "opt-in works after a persisted off");
});

test("fresh module (restart) defaults to ON again", async () => {
	const extDefault = await loadExtension("restart");
	const h = runExtension(extDefault);
	await h.startSession();
	assert.notEqual(h.current(), borderFactory, "default is ON in a fresh process");
});
