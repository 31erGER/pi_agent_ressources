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
 * 4. v1.4: verifies the git changes probe against a REAL temp git repo (init/commit/
 *    modify/untracked/commit-again → session-scoped counts), not-a-repo detection,
 *    TTL-cache identity, and the factory's resources_discover → baseline capture.
 * 5. v1.5: verifies the MTP probe against the REAL LM Studio (skipped when the
 *    server is down or reports no draft stats) and the perf-store → rating flow
 *    on real session data.
 */
import { execFileSync } from "node:child_process";
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
// v1.5: same for the tool-perf store
const PERF_FILE = path.join(storeDir, "perf-stats.json");
process.env.PI_STATS_PERF_FILE = PERF_FILE;

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

// v1.5: last-turn window on real entries + perf-store → rating flow
{
  assert.ok(data.performance.last, "last turn window present");
  assert.equal(data.performance.last?.count, 1, "last turn = single most recent item");

  new ext.PerfStore(PERF_FILE).record("read", 120);
  const data5 = ext.collectStats(pi, ctx, { usageStorePath: STORE_FILE, perfStorePath: PERF_FILE });
  assert.ok(data5.ratings, "ratings section present");
  const readR = data5.ratings!.tools.find((t) => t.name === "read");
  assert.ok(readR, "read tool rated");
  assert.ok(readR!.rating >= 1 && readR!.rating <= 5, `rating within 1..5 (got ${readR!.rating})`);
  assert.equal(readR!.avgMs, 120, "measured avg ms flows into the rating");
  assert.ok(data5.ratings!.extensions.some((e) => e.name.includes("stats")), "stats.ts rated as extension");
  const statsR = data5.ratings!.extensions.find((e) => e.name.includes("stats"))!;
  assert.ok(statsR.rating >= 1 && statsR.rating <= 5, `extension rating within 1..5 (got ${statsR.rating})`);
  const rendered5 = ext.buildStatsLines(data5, 160).map((l: { text: string }) => l.text).join("\n");
  assert.ok(rendered5.includes("perf rating"), "perf rating section rendered");
  assert.ok(rendered5.includes("last turn") && rendered5.includes("tok/s"), "last turn perf row rendered");
}

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

// ------------------------------------------------ 4) v1.4: git changes probe (real repo)
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stats-it-repo-"));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const g = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repo, env: gitEnv }).toString().trim();
  const commit = (msg: string): void => {
    execFileSync("git", ["-c", "user.email=int@test", "-c", "user.name=int", "commit", "-qm", msg], {
      cwd: repo,
      env: gitEnv,
    });
  };

  fs.writeFileSync(path.join(repo, "a.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  g("add", "-A");
  commit("init");
  const baseline = g("rev-parse", "HEAD");

  // tracked change: drop 2 lines, append 5  →  +5 -2 ; plus an untracked 7-line file
  const kept = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 8", "line 9", "line 10"];
  fs.writeFileSync(path.join(repo, "a.txt"), kept.join("\n") + "\n" + Array.from({ length: 5 }, (_, i) => `new ${i + 1}`).join("\n") + "\n");
  fs.writeFileSync(path.join(repo, "b.md"), Array.from({ length: 7 }, (_, i) => `u${i + 1}`).join("\n") + "\n");

  ext.resetGitProbeCacheForTests();
  const r1 = await ext.collectGitChanges(repo, baseline);
  assert.equal(r1.kind, "changes");
  if (r1.kind === "changes") {
    assert.equal(r1.changes.added, 5, "tracked added lines");
    assert.equal(r1.changes.deleted, 2, "tracked deleted lines");
    assert.equal(r1.changes.files, 1);
    assert.deepEqual(r1.changes.untracked, { files: 1, added: 7 });
    assert.equal(r1.changes.top[0]?.path, "a.txt");
  }

  // commits made DURING the session still count (diff is baseline→working tree)
  g("add", "-A");
  commit("work");
  ext.resetGitProbeCacheForTests();
  const r2 = await ext.collectGitChanges(repo, baseline);
  if (r2.kind === "changes") {
    assert.equal(r2.changes.added, 12, "committed work still counted (5 in a.txt + 7 in b.md)");
    assert.equal(r2.changes.deleted, 2);
    assert.equal(r2.changes.files, 2, "a.txt + newly tracked b.md");
    assert.deepEqual(r2.changes.untracked, { files: 0, added: 0 });
  } else {
    assert.fail(`expected changes, got ${r2.kind}`);
  }

  // TTL cache: second call inside the window returns the identical cached object
  const r3 = await ext.collectGitChanges(repo, baseline);
  assert.equal(r3, r2, "cache identity within TTL");

  // non-repo directory
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "stats-it-norepo-"));
  ext.resetGitProbeCacheForTests();
  const r4 = await ext.collectGitChanges(notRepo, null);
  assert.equal(r4.kind, "not-repo");

  // factory wiring: resources_discover captures the session-start baseline.
  // NOTE: use ext.default (native instance) — the jiti `factory` above is a
  // SEPARATE module instance with separate state (in prod, pi loads everything
  // through one jiti runtime, so the wiring is single-instance).
  const handlers: Record<string, (e: unknown) => void> = {};
  (ext.default as (pi: {
    registerCommand: (name: string, opts: { description?: string; handler: unknown }) => void;
    on: (event: string, handler: unknown) => () => void;
  }) => void)({
    registerCommand: () => {},
    on: (event, handler) => {
      handlers[event] = handler as (e: unknown) => void;
      return () => {};
    },
  });
  const headNow = g("rev-parse", "HEAD");
  handlers["resources_discover"]?.({ type: "resources_discover", cwd: repo, reason: "startup" });
  await new Promise((r) => setTimeout(r, 400)); // let rev-parse spawn finish
  const bl = ext.currentGitBaseline();
  assert.equal(bl?.cwd, repo, "baseline cwd captured on resources_discover");
  assert.equal(bl?.head, headNow, "baseline HEAD captured (the HEAD at capture time = session start in prod)");

  // rendered dashboard shows the changes section when git data is present
  const withGit = { ...data, git: r1 };
  const gitLines = ext.buildStatsLines(withGit, 100).map((l: { text: string }) => l.text);
  assert.ok(gitLines.some((t) => t.startsWith("changes (this session, git)")), "changes section rendered");
  assert.ok(gitLines.some((t) => t.includes("+5") && t.includes("-2")), "tracked totals rendered");
  assert.ok(gitLines.some((t) => t.includes("untracked")), "untracked line rendered");

  console.log("  ok - git changes probe: session-scoped counts, commit-still-counts, cache, not-repo, baseline capture");
}

// ------------------------------------- 5) v1.5: MTP probe against real LM Studio
{
  let model: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("http://localhost:1234/api/v0/models", { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json()) as { data: { id: string; model_type?: string }[] };
      const m = body.data.find((x) => x.model_type === "llm" || x.model_type === "vlm");
      model = m?.id ?? body.data[0]?.id ?? null;
    }
  } catch {
    model = null;
  }

  if (!model) {
    console.log("  skip - LM Studio not running (MTP probe untestable)");
  } else {
    const mtp = await ext.probeMtpAcceptance(model);
    if (mtp) {
      assert.ok(mtp.total > 0, "draft tokens observed");
      assert.ok(mtp.accepted >= 0 && mtp.accepted <= mtp.total, "accepted within total");
      assert.ok(mtp.rate >= 0 && mtp.rate <= 1, "rate in [0,1]");
      console.log(`  ok - MTP probe (real LM Studio, ${model}): ${Math.round(mtp.rate * 100)}% accepted (${mtp.accepted}/${mtp.total} drafts)`);
    } else {
      console.log(`  skip - LM Studio up (${model}) but no draft stats in response (speculative decoding may be off)`);
    }
    const mtp2 = await ext.probeMtpAcceptance(model);
    assert.equal(mtp2, mtp, "MTP probe cached within 60 s (no second request)");
  }
}

console.log(`\n${5} integration checks passed`);
