/**
 * Load smoke test: the default export must register cleanly against a stub
 * ExtensionAPI, install the idempotent TuiAltScreen.prototype.start patch,
 * and survive a stub session_start / custom / onTerminalInput round-trip.
 *
 * Run: node /home/julian/.pi/agent/projects/message-markers/tests/message-markers.load-smoke.ts
 */

import { strict as assert } from "node:assert";
import { Container, TuiAltScreen, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import defaultExport, {
	installRail,
	MarkerRail,
	RailDocument,
	railStateForTests,
	type RailState,
} from "../../../extensions/message-markers.ts";

let failures = 0;
let passes = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passes++;
			console.log(`  ok   ${name}`);
		})
		.catch((err) => {
			failures++;
			console.error(`  FAIL ${name}`);
			console.error(String(err).split("\n").slice(0, 5).join("\n"));
		});
}

// --- stub ExtensionAPI ------------------------------------------------------

const notifications: string[] = [];
const commands: Record<string, { description: string; handler: (args: string, ctx: unknown) => unknown }> = {};
const terminalHandlers: Array<(data: string) => unknown> = [];

const fakeTui = {
	mode: "fullscreen",
	stopped: false,
	requestRender: () => {},
};

const sessionHandlers: Array<(event: unknown, ctx: unknown) => void> = [];

const stubPi = {
	on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
		if (event === "session_start") sessionHandlers.push(handler);
	},
	registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: unknown) => unknown }) => {
		commands[name] = def;
	},
};

function ctxStub(mode: string) {
	return {
		mode,
		ui: {
			theme: { fg: (_color: string, text?: string) => text ?? "" },
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v?: unknown) => void) => unknown) => {
				const doneCalls: unknown[] = [];
				const done = (v?: unknown) => {
					doneCalls.push(v);
				};
				const component = factory(fakeTui, ctxStub(mode).ui.theme, {}, done);
				assert.ok(doneCalls.length > 0, "factory must call done() synchronously (no flash)");
				assert.ok(component && typeof (component as { render?: unknown }).render === "function");
				return Promise.resolve();
			},
			onTerminalInput: (handler: (data: string) => unknown) => {
				terminalHandlers.push(handler);
				return () => {
					const i = terminalHandlers.indexOf(handler);
					if (i >= 0) terminalHandlers.splice(i, 1);
				};
			},
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	};
}

// The parent (TuiBase) start reference before patching.
const parentStartRef = (Object.getPrototypeOf(TuiAltScreen.prototype) as { start: unknown }).start;

// --- tests -------------------------------------------------------------------

await test("default export registers session_start handler and /markers command", async () => {
	assert.equal(typeof defaultExport, "function");
	defaultExport(stubPi as never);
	assert.ok(sessionHandlers.length >= 1, "session_start handler registered");
	assert.ok(commands["markers"], "/markers command registered");
	assert.match(commands["markers"].description, /markers/i);
});

await test("start patch: own start installed, parent start untouched, idempotent", async () => {
	const proto = TuiAltScreen.prototype as unknown as { start?: unknown };
	assert.equal(Object.prototype.hasOwnProperty.call(proto, "start"), true, "own patched start exists");
	assert.equal(typeof proto.start, "function");
	assert.equal(
		(Object.getPrototypeOf(TuiAltScreen.prototype) as { start: unknown }).start,
		parentStartRef,
		"parent start reference untouched",
	);
	const first = proto.start;
	defaultExport(stubPi as never); // re-run entry (e.g. /reload): must not re-patch
	assert.equal(proto.start, first, "idempotent: same patched function");
});

await test("patched start invokes the original (its failure propagates) and schedules install on next tick", async () => {
	const patched = (TuiAltScreen.prototype as unknown as { start: () => void }).start;
	// A fake `this` makes the real TuiBase.start throw immediately (it needs a
	// real TUI instance). That proves the original was invoked; the rail
	// install is scheduled for the next tick and must not crash the process.
	let threw = false;
	try {
		patched.call({ mode: "fullscreen", stopped: false });
	} catch {
		threw = true;
	}
	assert.ok(threw, "original start ran (and threw on the fake instance)");
	await new Promise((r) => setImmediate(r)); // the scheduled install must be exception-safe
});

await test("session_start wiring: registers terminal input in tui mode only", async () => {
	const before = terminalHandlers.length;
	sessionHandlers.at(-1)?.({ reason: "startup" }, ctxStub("tui"));
	assert.ok(terminalHandlers.length > before, "onTerminalInput registered in tui mode");
	const beforeRpc = terminalHandlers.length;
	sessionHandlers.at(-1)?.({ reason: "startup" }, ctxStub("rpc"));
	assert.equal(terminalHandlers.length, beforeRpc, "rpc mode: no terminal input handlers");
});

await test("alt+up/alt+down without transcript pass through (no crash); plain arrows untouched", async () => {
	const handler = terminalHandlers[terminalHandlers.length - 1];
	assert.equal(handler("\x1b[A"), undefined, "plain up passes through");
	assert.equal(handler("\x1b[B"), undefined, "plain down passes through");
	assert.equal(handler("\u001b\u001b[A"), undefined, "alt+up w/o transcript passes through");
	assert.equal(handler("\u001b\u001b[B"), undefined, "alt+down w/o transcript passes through");
});

await test("/markers off/status/on run without crashing in tui mode", async () => {
	const ctx = ctxStub("tui");
	await commands["markers"].handler("off", ctx);
	await commands["markers"].handler("status", ctx);
	await commands["markers"].handler("on", ctx);
	assert.ok(notifications.some((n) => /off/.test(n)), "off notifies");
	assert.ok(notifications.some((n) => /on/.test(n)), "on notifies");
	assert.ok(notifications.some((n) => /message markers/.test(n)), "status notifies");
});

await test("/markers in rpc mode notifies an error and does not crash", async () => {
	const before = notifications.length;
	await commands["markers"].handler("status", ctxStub("rpc"));
	assert.ok(notifications.length > before);
	assert.ok(notifications.slice(before).some((n) => /interactive mode/i.test(n)));
});

await test("overlay: stale captured ctx (session-replacement window) must not crash the render path", async () => {
	const ctx1 = ctxStub("tui");
	sessionHandlers.at(-1)?.({ reason: "startup" }, ctx1);
	const state = railStateForTests();
	state.enabled = true;
	state.activeTui = fakeTui;
	const userMsg = { text: "hello", markdownTransformers: [] };
	state.transcript = {
		child: { children: [userMsg] },
		scrollTop: 0,
		viewportHeight: 10,
	} as unknown as RailState["transcript"];
	// The session was replaced: the captured ctx is stale and its `ui`
	// getter now throws — exactly what ExtensionRunner.assertActive does.
	Object.defineProperty(ctx1, "ui", {
		configurable: true,
		get() {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	});
	const rail = new MarkerRail(state);
	const lines = new Array(10).fill("");
	const out = rail.overlay(lines, 80); // pre-fix: throws the stale error
	assert.equal(out.length, 10);
	assert.ok(out.some((l) => l.includes("▸")), "marker rendered with the last known (fallback) theme");
});

await test("getTheme recovers: the replacement's fresh session_start ctx is used again", async () => {
	const ctx2 = ctxStub("tui");
	// fg must return a 2-visible-column mark (compositeTuiLine clips to 2 cols).
	(ctx2.ui as { theme: { fg: (c: string, t?: string) => string } }).theme = {
		fg: () => "◆ ",
	};
	sessionHandlers.at(-1)?.({ reason: "resume" }, ctx2);
	const state = railStateForTests();
	const lines = new Array(10).fill("");
	const out = new MarkerRail(state).overlay(lines, 80);
	assert.ok(out.some((l) => l.includes("◆")), "new ctx theme used after replacement");
});

await test("installRail: disabled state short-circuits before touching the TUI", () => {
	// Any property access on the trapped TUI throws, so a disabled install
	// must not read a single field off it (no wrap, no state mutation).
	const trapTui = new Proxy(
		{},
		{
			get(_target, prop) {
				throw new Error(`installRail touched tui.${String(prop)} while disabled`);
			},
		},
	);
	const state: RailState = {
		enabled: false,
		activeTui: null,
		transcript: null,
		getTheme: () => ({ fg: (_c: string, text?: string) => text ?? "" }),
		lastWidth: 0,
		docHeight: 0,
		cacheKey: null,
		offsets: [],
	};
	const rail = new MarkerRail(state);
	installRail(trapTui as unknown as TUI, state, rail); // must not throw
	assert.equal(state.activeTui, null, "state.activeTui untouched");
	assert.equal(state.transcript, null, "state.transcript untouched");
});

// --- mouse: clickable markers ------------------------------------------------

/**
 * Fake transcript geometry: 4 user messages × 12 rows at width 100.
 * rows = [0, 12, 24, 36], docHeight 48, scrollTop 10, viewport 40.
 * → active = 3, marks = 4 (no ellipsis), top = floor((38-4)/2) = 17,
 *   col = 96; doc rows of marks: 27, 28, 29, 30.
 */
function setupMouseTest(rows: number, perMsg: number) {
	// Production shape: the transcript document is a Container whose children
	// include user-shaped components with their own render().
	const doc = new Container();
	for (let i = 0; i < rows; i++) {
		doc.addChild({
			text: `user text ${i}`,
			markdownTransformers: [],
			render: () => new Array(perMsg).fill(""),
		} as never);
	}
	const state = railStateForTests();
	state.enabled = true;
	// hermetic theme (earlier tests swap in a "◆ " theme)
	state.getTheme = () => ({ fg: (_c: string, text?: string) => text ?? "" });
	state.activeTui = { mode: "fullscreen", stopped: false, requestRender: () => {} } as never;
	state.lastWidth = 100;
	state.cacheKey = null;
	const scrolls: number[] = [];
	const renders = { n: 0 };
	const rail = new MarkerRail(state);
	const wrapped = new RailDocument(doc as never, rail);
	state.transcript = {
		child: wrapped,
		scrollTop: 10,
		viewportHeight: 40,
		scrollTo: (row: number) => {
			scrolls.push(row);
		},
	} as unknown as RailState["transcript"];
	state.docHeight = rows * perMsg;
	return { wrapped, scrolls, renders, state };
}

/** Strip escape/OSC sequences → the visible cell text of a rendered line. */
function visible(line: string): string {
	return line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** A realistic TuiMouseEvent (the TUI always fills width/height/button). */
function evt(type: string, x: number, y: number, height: number): TuiMouseEvent {
	return { type, button: "left", x, y, screenX: x, screenY: y, width: 100, height, shift: false, alt: false, ctrl: false } as unknown as TuiMouseEvent;
}

await test("overlay: markers render at col 96 (3 cols left of the scrollbar at 99)", async () => {
	const { wrapped } = setupMouseTest(4, 12);
	const out = wrapped.render(100);
	assert.equal(out.length, 48);
	// doc rows 27..30 hold the marks (scrollTop 10 + top 17 + i)
	assert.equal(visible(out[27]).indexOf("·"), 96, "first dot at col 96");
	assert.equal(visible(out[30]).indexOf("▸"), 96, "active marker at col 96");
	assert.equal(visible(out[26]).indexOf("·"), -1, "nothing above the rail block");
	assert.equal(visible(out[27]).slice(96, 98), "· ", "glyph occupies cols 96-97");
	assert.ok([...visible(out[27]).slice(98)].every((c) => c === " "), "scrollbar col 99 untouched");
});

await test("click on a dot jumps to that user message", async () => {
	const { wrapped, scrolls } = setupMouseTest(4, 12);
	const res = wrapped.handleMouse(evt("click", 96, 28, 48));
	assert.deepEqual(res, { handled: true }, "click on the rail is consumed");
	assert.deepEqual(scrolls, [12], "scrolled to the 2nd user message");
});

await test("click band is 1 column wide on each side of the glyph", async () => {
	const { wrapped, scrolls } = setupMouseTest(4, 12);
	const left = wrapped.handleMouse(evt("click", 95, 28, 48));
	assert.ok(left && left.handled, "col 95 (glyph start) is in the band");
	assert.deepEqual(scrolls, [12]);
	scrolls.length = 0;
	const right = wrapped.handleMouse(evt("click", 97, 28, 48));
	assert.ok(right && right.handled, "col 97 (glyph+space) is in the band");
	assert.deepEqual(scrolls, [12]);
	scrolls.length = 0;
	const outside = wrapped.handleMouse(evt("click", 94, 28, 48));
	assert.equal(outside, undefined, "col 94 passes through (selection intact)");
	assert.deepEqual(scrolls, [], "no scroll on pass-through");
});

await test("press in the band is claimed (no selection) but does not scroll yet", async () => {
	const { wrapped, scrolls } = setupMouseTest(4, 12);
	const res = wrapped.handleMouse(evt("press", 96, 28, 48));
	assert.deepEqual(res, { handled: true, render: false });
	assert.deepEqual(scrolls, [], "jump happens on click, not press");
});

await test("click inside the band but off the rail block / on an ellipsis does nothing", async () => {
	const { wrapped, scrolls } = setupMouseTest(4, 12);
	const res = wrapped.handleMouse(evt("click", 96, 26, 48));
	assert.ok(res && res.handled && res.render === false, "consumed, no jump");
	assert.deepEqual(scrolls, []);

	// 8 messages, viewport 8 → capacity 6 → trailing ellipsis at doc row 16
	const eight = setupMouseTest(8, 12);
	(eight.state.transcript as { viewportHeight: number }).viewportHeight = 8;
	const dot = eight.wrapped.handleMouse(evt("click", 96, 11, 96));
	assert.ok(dot && dot.handled);
	assert.deepEqual(eight.scrolls, [12], "first real dot jumps to message 2");
	eight.scrolls.length = 0;
	const dots = eight.wrapped.handleMouse(evt("click", 96, 16, 96));
	assert.ok(dots && dots.handled && dots.render === false, "ellipsis consumed, no jump");
	assert.deepEqual(eight.scrolls, []);
});

await test("mouse pass-through when the rail is disabled", async () => {
	const { wrapped, scrolls } = setupMouseTest(4, 12);
	wrapped.rail.state.enabled = false;
	const res = wrapped.handleMouse(evt("click", 96, 28, 48));
	assert.equal(res, undefined, "disabled rail passes the click through");
	assert.deepEqual(scrolls, []);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
