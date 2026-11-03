import { createJiti } from "file:///home/julian/.pi/agent/install/releases/1.5.0/node_modules/jiti/lib/jiti.mjs";
import { visibleWidth } from "/home/julian/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-tui/dist/index.js";

// Mirror pi's own extension loader (loader.js getAliases()) so bare imports
// in the extension resolve exactly as they do inside pi.
const REL = "/home/julian/.pi/agent/install/releases/1.5.0/node_modules";
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

const DASH = "─";
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// label prefix: /home/julian/projects/demo + HOME=/home/julian -> ~/projects/demo
const PWD = "~/projects/demo"; // 15 cols
const BUL = `${PWD} • `; // 18 cols

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
const footerFactories = [];
const makeCtx = () => ({
	mode: "tui",
	sessionManager: {
		getCwd: () => "/home/julian/projects/demo",
		getSessionName: () => sessionName,
	},
	model: undefined,
	thinkingLevel: undefined,
	getContextUsage: () => undefined,
	ui: {
		setEditorComponent: (f) => factories.push(f),
		setFooter: (f) => footerFactories.push(f),
	},
});
const ctx = makeCtx();
for (const h of handlers.session_start ?? []) h({ type: "session_start", reason: "startup" }, ctx);
check("setEditorComponent called once on session_start", factories.length === 1);
check("setFooter called once on session_start", footerFactories.length === 1);

// non-tui must not register
for (const h of handlers.session_start ?? [])
	h({ type: "session_start", reason: "startup" }, { mode: "rpc", sessionManager: {}, ui: {} });
check("no editor factory in non-tui mode", factories.length === 1);
check("no footer factory in non-tui mode", footerFactories.length === 1);

// --- mock tui / theme / keybindings ----------------------------------------
const tuiMock = { terminal: { rows: 40 }, requestRender() {} };
const themeMock = { borderColor: (s) => `\x1b[35m${s}\x1b[0m`, selectList: {} };
const kbMock = {};

const editor = factories[0](tuiMock, themeMock, kbMock);
check("editor instance created", editor && typeof editor.render === "function");

// --- case 0: no name -> path alone ------------------------------------------
sessionName = undefined;
let t = editor.render(80);
check("no name: 3+ lines", t.length >= 3);
check(
	"no name: 62 dash + ' ~/projects/demo ' + dash",
	strip(t[0]) === DASH.repeat(62) + ` ${PWD} ` + DASH && visibleWidth(t[0]) === 80,
	strip(t[0]),
);

// --- case 1: short name, wide terminal --------------------------------------
sessionName = "My Session";
t = editor.render(80);
let plain = strip(t[0]);
check(
	"short name: 50 dash + label + dash",
	plain === DASH.repeat(49) + ` ${PWD} • My Session ` + DASH,
	plain,
);
check("short name: width 80", visibleWidth(t[0]) === 80);
check(
	"short name: single colored tail segment",
	t[0] === `\x1b[35m${DASH.repeat(49)} ${PWD} • My Session ${DASH}\x1b[0m`,
	JSON.stringify(t[0]),
);

// --- case 2: 100-char name -> capped 70, then border re-truncates -----------
sessionName = "a".repeat(100);
t = editor.render(80);
plain = strip(t[0]);
check(
	"long name: budget 77 -> PWD• + 56 a + dots",
	plain === ` ${BUL}` + "a".repeat(56) + `... ` + DASH && visibleWidth(t[0]) === 80,
	plain,
);

// --- case 3: name exactly 70 chars (no name-cap dots; border re-truncates) --
sessionName = "b".repeat(70);
t = editor.render(80);
plain = strip(t[0]);
check(
	"70-char name: border re-truncates at 56 b",
	plain === ` ${BUL}` + "b".repeat(56) + `... ` + DASH,
	plain,
);

// --- case 4: name 71 chars (name cap 70+dots; border re-truncates) ----------
sessionName = "c".repeat(71);
t = editor.render(80);
plain = strip(t[0]);
check(
	"71-char name: border re-truncates at 56 c",
	plain === ` ${BUL}` + "c".repeat(56) + `... ` + DASH,
	plain,
);

// --- case 5: narrow terminal (60) with 100-char name -------------------------
sessionName = "d".repeat(100);
t = editor.render(60);
plain = strip(t[0]);
check(
	"narrow 60: budget 57 -> PWD• + 36 d + dots",
	plain === ` ${BUL}` + "d".repeat(36) + `... ` + DASH && visibleWidth(t[0]) === 60,
	plain,
);

// --- case 6: very narrow (10) ------------------------------------------------
t = editor.render(10);
plain = strip(t[0]);
check("narrow 10: '~/pr' + dots", plain === ` ~/pr... ` + DASH, plain);

// --- case 7: very narrow (6) -> no ellipsis room -----------------------------
t = editor.render(6);
plain = strip(t[0]);
check("narrow 6: '~/p' only", plain === ` ~/p ` + DASH, plain);

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
	"working border: spinner preserved, path•name at right",
	plain.startsWith("── ⠋ thinking...") && plain.endsWith(` ${PWD} • work ─`) && visibleWidth(t[0]) === 70,
	plain,
);
editor.setWorkingStatusIndicator(undefined);

// --- case 10: scroll indicator border (scrolled multi-line prompt) -----------
sessionName = "scroll-test";
editor.setText(Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n"));
t = editor.render(40);
plain = strip(t[0]);
check(
	"scroll border: '↑ N more' preserved, re-truncated label at right",
	plain.includes("↑ 8 more") && plain.endsWith(` ~/project... ─`) && visibleWidth(t[0]) === 40,
	plain,
);
editor.setText("");

// --- session switch: fresh ctx re-registers -----------------------------------
const ctx2 = makeCtx();
for (const h of handlers.session_start ?? []) h({ type: "session_start", reason: "resume" }, ctx2);
check("session switch: new factory registered", factories.length === 2);
const editor2 = factories[1](tuiMock, themeMock, kbMock);
// editor2 shares the module-level sessionName var via makeCtx closure
sessionName = "new session";
t = editor2.render(80);
check("new session name shown", strip(t[0]).endsWith(` ${PWD} • new session ─`), strip(t[0]));

// --- live name update within same session (/name while running) ---------------
sessionName = "renamed via /name";
t = editor.render(80);
check("live name update after /name", strip(t[0]).endsWith(` ${PWD} • renamed via /name ─`), strip(t[0]));

// --- whitespace name -> path alone -------------------------------------------
sessionName = "   ";
t = editor.render(80);
check("whitespace name -> path alone", strip(t[0]) === DASH.repeat(62) + ` ${PWD} ` + DASH, strip(t[0]));

// --- unicode width: CJK name (2 cols/char) ------------------------------------
sessionName = "会".repeat(40); // 80 visible columns
t = editor.render(90);
plain = strip(t[0]);
check("CJK name: width 90, label present, ends with dots", plain.endsWith(`... ─`) && plain.includes(`${PWD} • `) && visibleWidth(t[0]) === 90, plain);
check("CJK name: capped (33 CJK + dots, no 34th)", plain.includes("会".repeat(33) + "...") && !plain.includes("会".repeat(34)));

// --- cwd outside home -> raw path (no ~) --------------------------------------
const ctx3 = {
	mode: "tui",
	sessionManager: {
		getCwd: () => "/opt/data/run",
		getSessionName: () => "outside",
	},
	model: undefined,
	thinkingLevel: undefined,
	getContextUsage: () => undefined,
	ui: {
		setEditorComponent: (f) => factories.push(f),
		setFooter: (f) => footerFactories.push(f),
	},
};
for (const h of handlers.session_start ?? []) h({ type: "session_start", reason: "resume" }, ctx3);
const editor3 = factories[2](tuiMock, themeMock, kbMock);
t = editor3.render(80);
check("cwd outside home: raw path shown", strip(t[0]).endsWith(` /opt/data/run • outside ─`), strip(t[0]));

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
