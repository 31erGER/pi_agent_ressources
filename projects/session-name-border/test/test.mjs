import { createJiti } from "file:///home/julian/.pi/agent/install/releases/1.4.0/node_modules/jiti/lib/jiti.mjs";
import { visibleWidth } from "/home/julian/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-tui/dist/index.js";

// Mirror pi's own extension loader (loader.js getAliases()) so bare imports
// in the extension resolve exactly as they do inside pi.
const REL = "/home/julian/.pi/agent/install/releases/1.4.0/node_modules";
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": `${REL}/@earendil-works/pi-coding-agent/dist/index.js`,
		"@earendil-works/pi-tui": `${REL}/@earendil-works/pi-tui/dist/index.js`,
	},
});
const mod = jiti("/home/julian/.pi/agent/extensions/session-name-border.ts");
const modFactory = mod.default ?? mod;

let failures = 0;
function check(label, cond, extra = "") {
	if (cond) console.log(`ok   ${label}`);
	else {
		failures++;
		console.log(`FAIL ${label} ${extra}`);
	}
}

// --- mock ExtensionAPI, capture session_start registration -----------------
const handlers = {};
const pi = {
	on(event, handler) {
		(handlers[event] ??= []).push(handler);
		return () => {};
	},
	registerCommand() {},
};
modFactory(pi);
check("factory registers session_start handler", (handlers.session_start ?? []).length === 1);

let sessionName = "My Session";
const factories = [];
const ctx = {
	mode: "tui",
	sessionManager: { getSessionName: () => sessionName },
	ui: { setEditorComponent: (f) => factories.push(f) },
};
for (const h of handlers.session_start ?? []) h({ type: "session_start", reason: "startup" }, ctx);
check("setEditorComponent called once on session_start", factories.length === 1);

// non-tui must not register
for (const h of handlers.session_start ?? [])
	h({ type: "session_start", reason: "startup" }, { mode: "rpc", sessionManager: {}, ui: {} });
check("no editor factory in non-tui mode", factories.length === 1);

// --- mock tui / theme / keybindings ----------------------------------------
const DASH = "─";
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tuiMock = { terminal: { rows: 40 }, requestRender() {} };
const themeMock = { borderColor: (s) => `\x1b[35m${s}\x1b[0m`, selectList: {} };
const kbMock = {};

const editor = factories[0](tuiMock, themeMock, kbMock);
check("editor instance created", editor && typeof editor.render === "function");

// --- case 0: no name -> border untouched ------------------------------------
sessionName = undefined;
let t = editor.render(80);
check("no name: 3+ lines", t.length >= 3);
check("no name: plain 80-dash border", strip(t[0]) === DASH.repeat(80) && visibleWidth(t[0]) === 80);

// --- case 1: short name, wide terminal --------------------------------------
sessionName = "My Session";
t = editor.render(80);
let plain = strip(t[0]);
check(
	"short name: 67 dash + ' My Session ' + dash",
	plain === DASH.repeat(67) + " My Session " + DASH,
	JSON.stringify(plain),
);
check("short name: width 80", visibleWidth(t[0]) === 80);
check("short name: label colored", t[0].includes("\x1b[35m My Session \x1b[0m"), JSON.stringify(t[0]));

// --- case 2: 100-char name -> 70 + "..." -------------------------------------
sessionName = "a".repeat(100);
t = editor.render(80);
plain = strip(t[0]);
check("long name: first 70 chars + '...'", plain === DASH.repeat(4) + " " + "a".repeat(70) + "... " + DASH, plain);
check("long name: width 80", visibleWidth(t[0]) === 80);

// --- case 3: name exactly 70 chars -> no ellipsis ----------------------------
sessionName = "b".repeat(70);
t = editor.render(80);
plain = strip(t[0]);
check("70-char name: full, no dots", plain === DASH.repeat(7) + " " + "b".repeat(70) + " " + DASH, plain);

// --- case 4: name 71 chars -> 70 + dots -------------------------------------
sessionName = "c".repeat(71);
t = editor.render(80);
plain = strip(t[0]);
check("71-char name: 70 + dots", plain === DASH.repeat(4) + " " + "c".repeat(70) + "... " + DASH, plain);

// --- case 5: narrow terminal (60) with 100-char name -------------------------
sessionName = "d".repeat(100);
t = editor.render(60);
plain = strip(t[0]);
check("narrow 60: re-truncated 54 + dots", plain === " " + "d".repeat(54) + "... " + DASH, plain);
check("narrow 60: width 60", visibleWidth(t[0]) === 60);

// --- case 6: very narrow (10) ------------------------------------------------
t = editor.render(10);
plain = strip(t[0]);
check("narrow 10: 4 + dots", plain === " " + "d".repeat(4) + "... " + DASH, plain);

// --- case 7: very narrow (6) -> no ellipsis room -----------------------------
t = editor.render(6);
plain = strip(t[0]);
check("narrow 6: 3 chars only", plain === " " + "d".repeat(3) + " " + DASH, plain);

// --- case 8: absurdly narrow (3) -> plain border -----------------------------
t = editor.render(3);
plain = strip(t[0]);
check("narrow 3: plain border", plain === DASH.repeat(3), plain);

// --- case 9: working-status border (spinner on the left) ----------------------
sessionName = "work";
editor.setWorkingStatusIndicator({
	renderInBorder: () => "\x1b[1m⠋ thinking...\x1b[0m",
	renderSpinnerInBorder: () => "\x1b[1m⠋\x1b[0m",
});
t = editor.render(70);
plain = strip(t[0]);
check(
	"working border: spinner preserved, name at right",
	plain.startsWith("── ⠋ thinking...") && plain.endsWith(" work ─") && visibleWidth(t[0]) === 70,
	plain,
);
editor.setWorkingStatusIndicator(undefined);

// --- case 10: scroll indicator border (scrolled multi-line prompt) -----------
sessionName = "scroll-test";
editor.setText(Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n"));
t = editor.render(40);
plain = strip(t[0]);
check(
	"scroll border: '↑ N more' preserved, name at right",
	plain.includes("↑ 8 more") && plain.endsWith(" scroll-test ─") && visibleWidth(t[0]) === 40,
	plain,
);
editor.setText("");

// --- session switch: fresh ctx re-registers -----------------------------------
const ctx2 = {
	mode: "tui",
	sessionManager: { getSessionName: () => "new session" },
	ui: { setEditorComponent: (f) => factories.push(f) },
};
for (const h of handlers.session_start ?? []) h({ type: "session_start", reason: "resume" }, ctx2);
check("session switch: new factory registered", factories.length === 2);
const editor2 = factories[1](tuiMock, themeMock, kbMock);
t = editor2.render(80);
check("new session name shown", strip(t[0]).endsWith(" new session ─"), strip(t[0]));

// --- live name update within same session (/name while running) ---------------
sessionName = "renamed via /name";
t = editor.render(80);
check("live name update after /name", strip(t[0]).endsWith(" renamed via /name ─"), strip(t[0]));

// --- empty/whitespace name -> no label ---------------------------------------
sessionName = "   ";
t = editor.render(80);
check("whitespace name -> plain border", strip(t[0]) === DASH.repeat(80), strip(t[0]));

// --- unicode width: CJK name (2 cols/char) ------------------------------------
sessionName = "会".repeat(40); // 80 visible columns
t = editor.render(90);
const p5 = strip(t[0]);
check(
	"CJK name capped at 70 visible cols + dots",
	p5.includes("会".repeat(35) + "... ") && !p5.includes("会".repeat(36)),
	p5,
);
check("CJK line width 90", visibleWidth(t[0]) === 90);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
