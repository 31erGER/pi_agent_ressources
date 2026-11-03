// End-to-end check with pi's REAL extension loader (same path pi uses at startup).
import { loadExtensions } from "/home/julian/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { visibleWidth } from "/home/julian/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-tui/dist/index.js";

const DASH = "─";
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
let failures = 0;
const check = (label, cond, extra = "") => {
	if (cond) console.log(`ok   ${label}`);
	else {
		failures++;
		console.log(`FAIL ${label} ${extra}`);
	}
};

const result = await loadExtensions(
	["/home/julian/.pi/agent/extensions/session-name-border.ts"],
	"/home/julian",
);
check("real loader: exactly one extension", result.extensions.length === 1, JSON.stringify(result.extensions.map((e) => e.path)));
check("real loader: no load errors", result.errors.length === 0, JSON.stringify(result.errors));

const ext = result.extensions[0];
const registered = ext.handlers.get("session_start") ?? [];
check("session_start registered", registered.length === 1);

let sessionName = "real loader session";
const factories = [];
const ctx = {
	mode: "tui",
	sessionManager: { getSessionName: () => sessionName },
	ui: { setEditorComponent: (f) => factories.push(f) },
};
for (const h of registered) await h({ type: "session_start", reason: "startup" }, ctx);
check("setEditorComponent called", factories.length === 1);

const editor = factories[0](
	{ terminal: { rows: 40 }, requestRender() {} },
	{ borderColor: (s) => `\x1b[34m${s}\x1b[0m`, selectList: {} },
	{},
);
sessionName = "x".repeat(100);
const lines = editor.render(100);
const plain = strip(lines[0]);
check(
	"real loader: long name -> 70 + '...' at right",
	plain === DASH.repeat(24) + " " + "x".repeat(70) + "... " + DASH && visibleWidth(lines[0]) === 100,
	plain,
);
console.log("sample:", JSON.stringify(lines[0].slice(0, 60) + " … " + lines[0].slice(-30)));

sessionName = "short";
const p2 = strip(editor.render(100)[0]);
check("real loader: short name at right edge", p2.endsWith(" short ─") && visibleWidth(p2) === 100, p2);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
