/**
 * Load smoke test: the default export must register cleanly against a stub
 * ExtensionAPI, install the idempotent TuiAltScreen.prototype.start patch,
 * and survive a stub session_start / custom / onTerminalInput round-trip.
 *
 * Run: node /home/julian/.pi/agent/projects/message-markers/tests/message-markers.load-smoke.ts
 */

import { strict as assert } from "node:assert";
import { TuiAltScreen, type TUI } from "@earendil-works/pi-tui";
import defaultExport, {
	installRail,
	MarkerRail,
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
		cacheKey: null,
		offsets: [],
	};
	const rail = new MarkerRail(state);
	installRail(trapTui as unknown as TUI, state, rail); // must not throw
	assert.equal(state.activeTui, null, "state.activeTui untouched");
	assert.equal(state.transcript, null, "state.transcript untouched");
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
