// Loads the ACTUAL extension file through pi's REAL extension loader
// (loadExtensions + jiti) and renders the produced editor + footer.
//
// Footer: golden differential test — the extension's custom footer is
// compared line-by-line against pi's real FooterComponent fed the SAME
// session data: it must be byte-identical except for the ` • <name>`
// suffix on the first line.
import { FooterComponent } from "/home/julian/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { loadExtensions } from "/home/julian/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { initTheme } from "/home/julian/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
initTheme(); // FooterComponent renders with the global interactive theme
import { visibleWidth } from "/home/julian/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-tui/dist/index.js";

let failures = 0;
function check(label, cond, extra = "") {
	if (cond) console.log(`ok   ${label}`);
	else {
		failures++;
		console.log(`FAIL ${label} ${extra}`);
	}
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const DASH = "─";

// --- shared mock session -----------------------------------------------------
const entries = [
	{ type: "usage", usage: { input: 5000, output: 1200, cacheRead: 3000, cacheWrite: 400, cost: { total: 0.031 } } },
	{ type: "message", message: { role: "user", content: [] } },
	{ type: "message", message: { role: "assistant", usage: { input: 8000, output: 2200, cacheRead: 6000, cacheWrite: 900, cost: { total: 0.052 } } } },
	{ type: "message", message: { role: "toolResult", toolCallId: "c1", name: "bash", isError: false, content: [], details: {}, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } },
];
let sessionName = "My long session name for footer";
const manager = {
	getCwd: () => "/home/julian/projects/demo",
	getSessionId: () => "sid-1",
	getLeafId: () => "leaf-1",
	getEntryCount: () => entries.length,
	getEntries: () => entries,
	getSessionName: () => sessionName,
};
const model = { id: "test-model", provider: "test-provider", reasoning: false, contextWindow: 200000 };
const contextUsage = { tokens: 45678, contextWindow: 200000, percent: 22.8 };
const realSession = {
	state: { model, thinkingLevel: undefined },
	model,
	routedModel: undefined,
	modelRuntime: { isUsingSubscription: () => false },
	getContextUsage: () => contextUsage,
	sessionManager: manager,
};
const footerProvider = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map([["global", "Σ↑ 123.4k  Σ↓ 12.3k  Σ $1.23"]]),
	getAvailableProviderCount: () => 2,
	onBranchChange: () => () => {},
};
const realFooter = new FooterComponent(realSession, footerProvider);

// --- real loader --------------------------------------------------------------
const result = await loadExtensions([
	"/home/julian/.pi/agent/extensions/session-name-border.ts",
], process.cwd());
check("loads with zero errors", result.errors.length === 0, JSON.stringify(result.errors));
check("one extension", result.extensions.length === 1);

const ext = result.extensions[0];
const handlerList = ext.handlers.get("session_start");
check(
	"session_start handler registered",
	Array.isArray(handlerList) && handlerList.length === 1 && typeof handlerList[0] === "function",
);
const handler = handlerList?.[0];

let editorFactory, footerFactory;
const mockCtx = {
	mode: "tui",
	sessionManager: manager,
	model,
	thinkingLevel: undefined,
	getContextUsage: () => contextUsage,
	ui: {
		setEditorComponent: (f) => { editorFactory = f; },
		setFooter: (f) => { footerFactory = f; },
	},
};
await handler({ type: "session_start", reason: "startup" }, mockCtx);
check("setEditorComponent called", typeof editorFactory === "function");
check("setFooter called", typeof footerFactory === "function");

// --- real CustomEditor from pi --------------------------------------------------
const editor = editorFactory(
	{ terminal: { rows: 40 }, requestRender() {} },
	{ borderColor: (s) => `\x1b[35m${s}\x1b[0m`, selectList: {} },
	{},
);
check("editor created", editor && typeof editor.render === "function");

// no name -> path alone
sessionName = undefined;
let lines = editor.render(100);
let plain = strip(lines[0]);
check(
	"no name: border shows ~/projects/demo",
	plain === DASH.repeat(82) + " ~/projects/demo " + DASH && visibleWidth(lines[0]) === 100,
	plain,
);

// long name -> path + 70 a + ...
sessionName = "a".repeat(100);
lines = editor.render(100);
plain = strip(lines[0]);
check(
	"long name: 70 a + dots (border budget fits)",
	plain === DASH.repeat(6) + " ~/projects/demo • " + "a".repeat(70) + "..." + " " + DASH && visibleWidth(lines[0]) === 100,
	plain,
);

// --- golden footer differential -------------------------------------------------
// Golden reference: pi's real FooterComponent fed the SAME session with the
// name hidden — my extension's footer must match it byte-for-byte.
const namelessManager = new Proxy(manager, {
	get(t, p) {
		if (p === "getSessionName") return () => undefined;
		const v = Reflect.get(t, p);
		return typeof v === "function" ? v.bind(t) : v;
	},
});
const goldenFooter = new FooterComponent({ ...realSession, sessionManager: namelessManager }, footerProvider);
const myFooter = footerFactory({}, {}, footerProvider);
check("footer created", myFooter && typeof myFooter.render === "function");

check(
	"sanity: golden line0 has path+branch, no name",
	strip(goldenFooter.render(200)[0]) === "~/projects/demo (main)",
	strip(goldenFooter.render(200)[0]),
);
check(
	"sanity: real line0 has the name suffix",
	strip(realFooter.render(200)[0]).endsWith(" • " + sessionName),
	strip(realFooter.render(200)[0]),
);

for (const w of [200, 100, 60, 30]) {
	const gl = goldenFooter.render(w);
	const ml = myFooter.render(w);
	check(`footer @${w}: nameless real footer minus the pwd line`, gl.length === ml.length + 1 && gl.slice(1).every((l, i) => l === ml[i]),
		`mine=[${ml.map(strip)}] golden=[${gl.map(strip)}]`);
}

// the pwd line is gone: my footer's first line is the stats line, no path
{
	const ml = myFooter.render(200);
	check("footer: pwd line removed (no path, starts with stats)", !ml.some((l) => strip(l).includes("~/projects/demo")) && strip(ml[0]).startsWith("↑"),
		`mine=[${ml.map(strip)}]`);
}

// live rename: real footer follows, mine does not
const before = myFooter.render(200)[0];
sessionName = "renamed session";
check("footer: name change does NOT affect custom footer", myFooter.render(200)[0] === before);
check("footer: real footer DOES follow the rename", strip(realFooter.render(200)[0]).includes(" • renamed session"), strip(realFooter.render(200)[0]));

// nameless: identical to the real nameless footer minus the pwd line
sessionName = "";
const rl = realFooter.render(120);
const ml = myFooter.render(120);
check("footer: nameless == real nameless footer minus pwd line", rl.length === ml.length + 1 && rl.slice(1).every((l, i) => l === ml[i]));

// dispose must not throw
myFooter.dispose();
check("footer: dispose ok", true);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
