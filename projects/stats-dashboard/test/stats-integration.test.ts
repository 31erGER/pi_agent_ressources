/**
 * Integration smoke test for the /stats extension.
 *
 * Run:  node test/stats-integration.test.ts   (from ~/.pi/agent/projects/stats-dashboard)
 *
 * 1. Loads ~/.pi/agent/extensions/stats.ts through jiti exactly like pi's loader does
 *    (createJiti + import with { default: true }) and verifies command registration.
 * 2. Runs collectStats() against a REAL session file (real entries, real system prompt
 *    replayed from the session's system message, real context files/skills) and renders
 *    the dashboard for visual inspection.
 * 3. v1.1: verifies the global usage store (env-redirected file), the factory's
 *    process-wide event subscriptions, and a jiti client extension self-reporting via
 *    import.meta.url (the exact wiring used by the sibling extensions).
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const INSTALL = "/home/julian/.pi/agent/install/releases/1.5.0/node_modules";
const EXT_PATH = path.join(os.homedir(), ".pi/agent/extensions/stats.ts");

// v1.1: isolate the global usage store in a temp file for this test run
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-it-store-"));
const STORE_FILE = path.join(storeDir, "usage-stats.json");
process.env.PI_STATS_USAGE_FILE = STORE_FILE;

// ------------------------------------------------- 1) jiti load like pi's loader
const { createJiti } = await import(path.join(INSTALL, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const factory = (await jiti.import(EXT_PATH, { default: true })) as (pi: {
  registerCommand: (name: string, opts: { description?: string; handler: unknown }) => void;
  on: (event: string, handler: unknown) => () => void;
}) => void;

let registered: { name: string; description?: string; handler: unknown } | undefined;
const onEvents = new Set<string>();
factory({
  registerCommand: (name, opts) => {
    registered = { name, ...opts };
  },
  on: (event) => {
    onEvents.add(event);
    return () => {};
  },
});
assert.equal(registered?.name, "stats");
assert.equal(typeof registered?.handler, "function");
// v1.1: process-wide usage tracking subscriptions
assert.ok(onEvents.has("input"), "factory must subscribe to input");
assert.ok(onEvents.has("tool_execution_start"), "factory must subscribe to tool_execution_start");
assert.ok(onEvents.has("session_start"), "factory must subscribe to session_start");
assert.ok(onEvents.has("resources_discover"), "factory must subscribe to resources_discover");
console.log("  ok - jiti loads extension, registers /stats, subscribes usage events");

// --------------------------------------------- 2) collectStats on a real session
const { SessionManager, getAgentDir, loadProjectContextFiles, loadSkills } = await import(
  "@earendil-works/pi-coding-agent"
);
const { getSystemMessageText } = await import(path.join(INSTALL, "@earendil-works/pi-ai/dist/index.js"));
const ext = await import("../../../extensions/stats.ts");

// newest session file
const sessionFiles: { p: string; m: number }[] = [];
for (const dir of fs.readdirSync(path.join(os.homedir(), ".pi/agent/sessions"))) {
  const full = path.join(os.homedir(), ".pi/agent/sessions", dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const f of fs.readdirSync(full)) {
    if (f.endsWith(".jsonl")) {
      const p = path.join(full, f);
      sessionFiles.push({ p, m: fs.statSync(p).mtimeMs });
    }
  }
}
sessionFiles.sort((a, b) => b.m - a.m);
assert.ok(sessionFiles.length > 0, "no session files found");
const sessionFile = sessionFiles[0].p;

const sm = SessionManager.open(sessionFile);
const entries = sm.getEntries();
assert.ok(entries.length > 5, `session too small: ${entries.length} entries`);

const cwd = "/home/julian";
const agentDir = getAgentDir();
const spOptions = {
  cwd,
  contextFiles: loadProjectContextFiles({ cwd, agentDir }),
  skills: loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills,
};
const sysMessage = entries
  .flatMap((e) => (e.type === "message" ? [e.message] : []))
  .find((m) => m.role === "system");
const promptText = sysMessage ? getSystemMessageText(sysMessage) : "integration fallback prompt";

const ctx = {
  mode: "tui",
  cwd,
  model: { provider: "smoke", id: "test-model", contextWindow: 200000 },
  thinkingLevel: "off",
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => undefined,
  getSystemPrompt: () => promptText,
  getSystemPromptOptions: () => spOptions,
  sessionManager: sm,
};

const pi = { getCommands: () => [], getSettings: () => ({ extensions: [] }) };
const data = ext.collectStats(pi, ctx, { usageStorePath: STORE_FILE });

// v1.1: global usage store — self-report through the exported helpers
ext.trackExtensionRun(EXT_PATH);
ext.trackSkillUse("integration-check");
{
  const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
  assert.equal(store.extensions[EXT_PATH]?.count, 1, "extension self-report persisted");
  assert.equal(store.skills["integration-check"]?.count, 1, "skill report persisted");
}
const dataUsage = ext.collectStats(pi, ctx, { usageStorePath: STORE_FILE });
{
  const statsExtItem = dataUsage.usage.extensions.find((e) => e.name.includes("stats"));
  assert.ok(statsExtItem, "stats.ts listed in usage section");
  assert.equal(statsExtItem?.count, 1, "global counter visible in dashboard data");
  assert.ok(statsExtItem?.added != null, "introduced date resolved");
  assert.ok(dataUsage.usage.skills.length > 0, "skills listed in usage section");
}
// v1.1: performance from real session entries
assert.ok(data.performance.session.count >= 2, "expected >=2 work items in real session");
assert.ok(data.performance.session.tokens > 0, "expected generated tokens");
assert.ok(data.performance.session.tps != null && data.performance.session.tps > 0, "expected session tokens/s");
assert.ok(data.performance.last10.count <= 10, "last10 window bounded");
assert.ok(data.performance.last100.count <= 100, "last100 window bounded");

assert.ok(data.messages.count > 0, "expected context messages");
assert.ok(data.messages.roles.length > 0, "expected role breakdown");
assert.ok(data.totals.turns > 0, "expected usage turns");
assert.ok(data.totals.input > 0, "expected input tokens");
assert.ok(data.systemPrompt.sections.length > 0, "expected system prompt sections");
assert.ok(data.systemPrompt.total > 100, "expected meaningful system prompt size");
assert.ok(data.resources.extensions.some((e) => e.name.includes("stats")), "expected stats.ts in loaded extensions");
assert.ok(data.resources.skills.length > 0, "expected skills");

// context tokens must match the core's own calculation
const { calculateContextTokens, getLastAssistantUsage } = await import("@earendil-works/pi-coding-agent");
const lastUsage = getLastAssistantUsage(entries);
if (lastUsage) {
  assert.equal(data.contextTokens, calculateContextTokens(lastUsage));
}

// render the full dashboard for eyeballing
const lines = ext.buildStatsLines(data, 100);
assert.ok(lines.length > 25, `dashboard too short: ${lines.length} lines`);
const dashboard = new ext.StatsDashboard(
  { fg: (_t: string, s: string) => s } as never,
  { requestRender: () => {}, terminal: { rows: 400 } } as never, // tall fake terminal: snapshot shows every section
  { matches: () => false } as never,
  data,
  () => {},
);
console.log("\n----- /stats dashboard (real session data, 160 cols) -----");
for (const line of dashboard.render(160)) console.log(line);
console.log("------------------------------------------------------------\n");
const rendered = dashboard.render(160).join("\n");
assert.ok(rendered.includes("usage (global"), "usage section rendered");
assert.ok(rendered.includes("performance (output tokens/s)"), "performance section rendered");
assert.ok(rendered.includes("tok/s"), "tokens/s value rendered");

console.log(`  ok - collectStats on real session (${entries.length} entries, ${data.messages.count} messages, ${data.totals.turns} turns)`);

// ------------------------------------- 3) jiti client self-report (import.meta.url)
// Mimics exactly what the instrumented sibling extensions do under pi's jiti loader.
{
  const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-it-client-"));
  const clientPath = path.join(clientDir, "usage-client.ts");
  fs.writeFileSync(
    clientPath,
    [
      `import { trackExtensionRun } from "${EXT_PATH}";`,
      `export default function (pi: any): void {`,
      `  pi.registerCommand("usageclient", { description: "integration", handler: async () => { trackExtensionRun(import.meta.url); } });`,
      `}`,
      ``,
    ].join("\n"),
  );
  const clientFactory = (await jiti.import(clientPath, { default: true })) as (p: unknown) => void;
  let clientHandler: (() => Promise<void>) | undefined;
  clientFactory({
    registerCommand: (_name: string, opts: { handler: unknown }) => {
      clientHandler = opts.handler as () => Promise<void>;
    },
    on: () => () => {},
  });
  assert.equal(typeof clientHandler, "function", "client command registered");
  await clientHandler!();
  const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
  const key = path.resolve(clientPath);
  assert.equal(store.extensions[key]?.count, 1, "jiti client self-reported via import.meta.url");
  console.log("  ok - jiti client extension self-reports through import.meta.url");
}

console.log(`\n${3} integration checks passed`);
