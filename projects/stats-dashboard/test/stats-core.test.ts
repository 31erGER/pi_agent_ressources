/**
 * Test suite for ~/.pi/agent/extensions/stats.ts (the /stats dashboard).
 *
 * Run:  node test/stats-core.test.ts   (from ~/.pi/agent/projects/stats-dashboard)
 *
 * Node >= 23.6 (type stripping) runs this .ts file directly. Bare
 * @earendil-works/* imports resolve via the node_modules symlinks in
 * ~/.pi/agent/node_modules (see README.md).
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import statsExt, {
  type ResourcesLike,
  type StatsContextLike,
  type StatsData,
  StatsDashboard,
  PerfStore,
  UsageStore,
  attributeSkillInput,
  bar,
  buildStatsColumns,
  buildStatsLines,
  clampScroll,
  collectLoadedResources,
  columnWidth,
  collectStats,
  extractWorkItems,
  fileIntroducedDate,
  formatAddedDate,
  formatCost,
  formatDuration,
  formatNumber,
  lastTurnWindow,
  parseMtpStats,
  parseNumstat,
  parseSystemPromptSections,
  parseToolList,
  parseUntrackedWc,
  perfStats,
  rateItem,
  roleBreakdown,
  staticSourceMetrics,
  sectionStats,
  skillUseFromRead,
  sumSessionUsage,
  textTokens,
  tokensPerSecond,
  trackExtensionRun,
  trackSkillUse,
  usageStorePath,
} from "../../../extensions/stats.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- fixtures

function assistantEntry(id: string, parentId: string | null, usage: object, text = "hi"): object {
  return {
    type: "message",
    id,
    parentId,
    timestamp: Date.now(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "prov",
      model: "mod",
      stopReason: "stop",
      usage,
    },
  };
}

function userEntry(id: string, parentId: string | null, text = "hello"): object {
  return { type: "message", id, parentId, timestamp: Date.now(), message: { role: "user", content: text } };
}

const fullUsage = {
  input: 100,
  output: 50,
  cacheRead: 1000,
  cacheWrite: 5,
  totalTokens: 1155,
  cost: { input: 0.0001, output: 0.0002, cacheRead: 0.00005, cacheWrite: 0.0001, total: 0.00035 },
};

function fakePi(overrides: Partial<ResourcesLike> = {}): ResourcesLike {
  return {
    getCommands: () => [],
    getSettings: () => ({ extensions: [] }),
    ...overrides,
  };
}

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stats-test-${prefix}-`));
}

// ------------------------------------------------------------------ tests

test("formatNumber: pi footer formatting", () => {
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(999), "999");
  assert.equal(formatNumber(1_234), "1.2k");
  assert.equal(formatNumber(9_999), "10k");
  assert.equal(formatNumber(1_234_567), "1.2M");
  assert.equal(formatNumber(15_000_000), "15M");
  assert.equal(formatNumber(NaN), "?");
});

test("bar: filled/empty blocks, clamped percent", () => {
  assert.equal(bar(0, 10), "░".repeat(10));
  assert.equal(bar(100, 10), "█".repeat(10));
  assert.equal(bar(50, 10), "█".repeat(5) + "░".repeat(5));
  assert.equal(bar(-20, 4), "░░░░");
  assert.equal(bar(120, 4), "████");
});

test("clampScroll: stays inside [0, content-viewport]", () => {
  assert.equal(clampScroll(0, 5, 100, 20), 5);
  assert.equal(clampScroll(19, 10, 100, 20), 29); // within bounds
  assert.equal(clampScroll(75, 10, 100, 20), 80); // clamped at max (100 - 20)
  assert.equal(clampScroll(80, 10, 100, 20), 80); // already at max
  assert.equal(clampScroll(0, -10, 100, 20), 0); // clamped at 0
  assert.equal(clampScroll(5, -1, 10, 20), 0); // content fits: always 0
});

test("textTokens: chars/4 via estimateTokens, string content", () => {
  assert.equal(textTokens(""), 0);
  assert.equal(textTokens("abcd"), 1);
  assert.equal(textTokens("abcdabcdabcd"), 3);
  assert.ok(textTokens("x".repeat(4000)) > 0);
});

test("parseSystemPromptSections: tagged sections + preamble, custom prompt fallback", () => {
  const prompt = [
    "You are a coding assistant.",
    "",
    "<tools>",
    "- read: reads",
    "</tools>",
    "",
    '<project_context>',
    'Project-specific instructions and guidelines:',
    '<project_instructions path="AGENTS.md">',
    "rules here",
    "</project_instructions>",
    "</project_context>",
    "",
    "<cwd>",
    "/home/u",
    "</cwd>",
  ].join("\n");
  const sections = parseSystemPromptSections(prompt);
  assert.equal(sections.preamble, "You are a coding assistant.");
  assert.equal(sections.tools, "- read: reads");
  assert.ok(sections.project_context.includes('<project_instructions path="AGENTS.md">'));
  assert.equal(sections.project_context.endsWith("</project_instructions>"), true);
  assert.equal(sections.cwd, "/home/u");
  assert.equal(Object.keys(sections).length, 4);

  const custom = parseSystemPromptSections("entirely opaque prompt");
  assert.deepEqual(Object.keys(custom), ["custom prompt"]);
  assert.equal(parseSystemPromptSections("")["custom prompt"], undefined);
});

test("sectionStats: skips null/empty, sorts by tokens desc", () => {
  const stats = sectionStats({ big: "x".repeat(400), small: "x".repeat(12), empty: "", gone: null });
  assert.deepEqual(
    stats.map((s) => s.name),
    ["big", "small"],
  );
  assert.equal(stats[0].tokens, 100);
  assert.equal(stats[1].tokens, 3);
  assert.equal(stats[0].chars, 400);
});

test("roleBreakdown: counts + per-role token estimates", () => {
  const roles = roleBreakdown([
    { role: "user", content: "aaaa" },
    { role: "assistant", content: [{ type: "text", text: "bbbb" }] },
    { role: "assistant", content: [{ type: "text", text: "cccc" }] },
    { role: "toolResult", content: "dddddd" },
    { role: "branchSummary", summary: "eeeeeeee" },
    { role: "mystery", content: "ffff" },
  ] as never[]);
  const byRole = Object.fromEntries(roles.map((r) => [r.role, r]));
  assert.equal(byRole.user?.count, 1);
  assert.equal(byRole.assistant?.count, 2);
  assert.equal(byRole.assistant?.tokens, 2); // 4 + 4 chars -> 1 + 1
  assert.equal(byRole.toolResult?.tokens, 2);
  assert.equal(byRole.branchSummary?.tokens, 2);
  assert.equal(byRole.mystery?.tokens, 0);
  // sorted by tokens desc; user(1) last among nonzero
  assert.ok(roles[0].tokens >= roles[roles.length - 1].tokens);
});

test("sumSessionUsage: assistant + compaction + branch_summary + usage entries only", () => {
  const entries: unknown[] = [
    userEntry("u1", null),
    assistantEntry("a1", "u1", fullUsage),
    assistantEntry("a2", "a1", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } }),
    { type: "compaction", id: "c1", parentId: "a2", usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 2, totalTokens: 13, cost: { total: 0.002 } } },
    { type: "branch_summary", id: "b1", parentId: "c1", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.0005 } } },
    { type: "usage", id: "s1", parentId: "b1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.0001 } } },
    { type: "custom", id: "x1", parentId: "s1", customType: "something" },
  ];
  const t = sumSessionUsage(entries);
  assert.equal(t.input, 100 + 10 + 7 + 2 + 1);
  assert.equal(t.output, 50 + 5 + 3 + 1 + 1);
  assert.equal(t.cacheRead, 1000 + 1);
  assert.equal(t.cacheWrite, 5 + 2);
  assert.equal(t.turns, 5);
  assert.ok(Math.abs(t.cost - (0.00035 + 0.001 + 0.002 + 0.0005 + 0.0001)) < 1e-9);
});

test("buildStatsColumns: two-column layout with all sections", () => {
  const d: StatsData = {
    model: "prov/mod",
    thinkingLevel: "high",
    sessionName: "my session",
    sessionId: "abc123",
    cwd: "/home/u/proj",
    status: "streaming",
    hasPending: true,
    contextTokens: 12400,
    contextWindow: 200000,
    contextPercent: 6.2,
    systemPrompt: {
      total: 2100,
      sections: [
        { name: "preamble", tokens: 1200, chars: 4800 },
        { name: "skills", tokens: 480, chars: 1920 },
        { name: "project_context", tokens: 320, chars: 1280 },
        { name: "docs", tokens: 90, chars: 360 },
      ],
    },
    contextFiles: [
      { path: "AGENTS.md", tokens: 300 },
      { path: ".pi/EXTRA.md", tokens: 20 },
    ],
    skillsInPrompt: 6,
    messages: {
      count: 70,
      tokens: 10300,
      roles: [
        { role: "assistant", count: 30, tokens: 4000 },
        { role: "toolResult", count: 28, tokens: 6100 },
        { role: "user", count: 12, tokens: 200 },
      ],
    },
    totals: { input: 1_200_000, output: 180_000, cacheRead: 3_400_000, cacheWrite: 90_000, cost: 4.2, turns: 132 },
    lastTurn: { input: 1200, output: 450, cacheRead: 11800, reasoning: 120 },
    resources: {
      contextFiles: [
        { name: "AGENTS.md", path: "AGENTS.md", scope: "" },
        { name: ".pi/EXTRA.md", path: ".pi/EXTRA.md", scope: "" },
      ],
      skills: [
        { name: "alpha", path: "~/s/alpha", scope: "user" },
        { name: "beta", path: "./.pi/skills/beta", scope: "project" },
      ],
      prompts: [{ name: "commit", path: "~/p/commit", scope: "user" }],
      extensions: [{ name: "stats.ts", path: "~/e/stats.ts", scope: "user" }],
      tools: ["read", "bash"],
    },
    usage: {
      skills: [
        { name: "alpha", count: 12, added: "2026-03-01" },
        { name: "beta", count: 0, added: null },
      ],
      extensions: [{ name: "stats.ts", count: 34, added: "2026-07-09" }],
      tools: [
        { name: "read", count: 42, added: "2026-11-02" },
        { name: "bash", count: 17, added: "2026-11-02" },
      ],
    },
    performance: {
      session: { count: 132, tokens: 1_200_000, seconds: 12_000, tps: 100 },
      last10: { count: 10, tokens: 12_400, seconds: 295, tps: 42 },
      last100: { count: 100, tokens: 121_000, seconds: 3360, tps: 36 },
    },
  };
  const { left, right, footer } = buildStatsColumns(d, 60, 60);
  const leftText = left.map((l) => l.text).join("\n");
  const rightText = right.map((l) => l.text).join("\n");

  // LEFT column = live session state
  assert.equal(left[0].text, "stats");
  assert.equal(left[0].color, "accent");
  assert.ok(leftText.includes("prov/mod"));
  assert.ok(leftText.includes("high"));
  assert.ok(leftText.includes("my session (abc123)"));
  assert.ok(leftText.includes("/home/u/proj"));
  assert.ok(leftText.includes("streaming"));
  assert.ok(leftText.includes("queued"));
  // context window + bar (6% of 30 => 2 filled)
  const barLine = left.find((l) => l.text.includes("200k"))!;
  assert.ok(barLine);
  assert.ok(barLine.text.includes("12k"));
  assert.ok(barLine.text.includes("6%"));
  assert.equal((barLine.text.match(/█/g) ?? []).length, 2);
  assert.ok(leftText.includes("system prompt"));
  assert.ok(leftText.includes("~2.1k"));
  // system prompt sections (sorted desc, per-file detail for project_context)
  const spIdx = left.findIndex((l) => l.text === "system prompt sections");
  assert.ok(spIdx > 0);
  assert.ok(left[spIdx + 1].text.includes("preamble"));
  assert.ok(leftText.includes("skills (6)"));
  const ctxSectionIdx = left.findIndex((l) => l.text.includes("project_context"));
  assert.ok(left[ctxSectionIdx + 1].text.includes("AGENTS.md"));
  assert.ok(left[ctxSectionIdx + 2].text.includes(".pi/EXTRA.md"));
  // messages by role
  assert.ok(leftText.includes("messages (70)"));
  assert.ok(leftText.includes("assistant"));
  assert.ok(leftText.includes("toolResult"));
  // tokens (session) + last turn
  assert.ok(leftText.includes("1.2M"));
  assert.ok(leftText.includes("180k"));
  assert.ok(leftText.includes("3.4M"));
  assert.ok(leftText.includes("$4.20"));
  assert.ok(leftText.includes("132 turns"));
  assert.ok(leftText.includes("last turn"));
  assert.ok(leftText.includes("↓450")); // output of last turn
  // performance (session/last10/last100)
  assert.ok(leftText.includes("performance (output tokens/s)"));
  assert.ok(leftText.includes("100.0 tok/s"));
  assert.ok(leftText.includes("42.0 tok/s"));
  assert.ok(leftText.includes("36.0 tok/s"));
  assert.ok(leftText.includes("1.2M out"));
  assert.ok(leftText.includes("12k out")); // formatNumber(12400) = "12k"
  assert.ok(leftText.includes("56m")); // last100: 3360s
  assert.ok(leftText.includes("4m55s")); // last10: 295s
  assert.ok(leftText.includes("last 10"));
  assert.ok(leftText.includes("last 100"));

  // RIGHT column = environment (loaded + global)
  assert.equal(right[0].text, "environment");
  assert.equal(right[0].color, "accent");
  assert.ok(rightText.includes("loaded resources"));
  assert.ok(rightText.includes("alpha, beta"));
  assert.ok(rightText.includes("/commit"));
  assert.ok(rightText.includes("stats.ts"));
  // v1.3: loaded tools listed
  assert.ok(rightText.includes("tools (2)"));
  // usage (global): skills / extensions / tools with counters + introduced dates
  assert.ok(rightText.includes("usage (global · all sessions)"));
  const usageIdx = right.findIndex((l) => l.text.startsWith("usage (global"));
  assert.ok(usageIdx > 0, "usage section missing");
  const usageText = right.slice(usageIdx).map((l) => l.text).join("\n");
  assert.ok(usageText.includes("12 uses"), "skill count missing");
  assert.ok(usageText.includes("2026-03-01"), "skill added date missing");
  assert.ok(usageText.includes("34 runs"), "extension count missing");
  assert.ok(usageText.includes("2026-07-09"), "extension added date missing");
  assert.ok(usageText.includes("42 runs"), "tool count missing");
  assert.ok(usageText.includes("2026-11-02"), "tool added date missing");
  // sorted by count desc: alpha (12) before beta (0)
  const alphaIdx = usageText.indexOf("alpha");
  const betaIdx = usageText.indexOf("beta");
  assert.ok(alphaIdx >= 0 && betaIdx >= 0 && alphaIdx < betaIdx, "usage entries not sorted by count desc");

  // footer (full-width hint)
  assert.ok(footer.text.includes("esc/q close"));
  assert.ok(footer.text.includes("refresh"));
  assert.equal(footer.color, "dim");
});

test("buildStatsLines: composes two columns with middle divider", () => {
  const d = dashboardData();
  const lines = buildStatsLines(d, 120);
  const bars = (s: string): number => (s.match(/│/g) ?? []).length;
  const title = lines[0].text;
  assert.ok(title.includes("stats"), "left group title missing");
  assert.ok(title.includes("environment"), "right group title missing");
  // inner rows carry exactly one middle divider (outer borders are added by the component)
  for (const l of lines.slice(0, -1)) {
    assert.equal(bars(l.text), 1, `content line must have exactly the middle divider: ${l.text}`);
  }
  const footer = lines[lines.length - 1].text;
  assert.equal(bars(footer), 0, "footer is full-width (no middle divider)");
  assert.ok(footer.includes("esc/q close"));
});

test("buildStatsLines: empty usage + no perf data render placeholders", () => {
  const d: StatsData = {
    ...({} as StatsData),
    model: "m/x",
    thinkingLevel: undefined,
    sessionName: undefined,
    sessionId: "i",
    cwd: "/x",
    status: "idle",
    hasPending: false,
    contextTokens: 10,
    contextWindow: 100,
    contextPercent: 10,
    systemPrompt: { total: 1, sections: [] },
    contextFiles: [],
    skillsInPrompt: 0,
    messages: { count: 0, tokens: 0, roles: [] },
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    lastTurn: null,
    resources: { contextFiles: [], skills: [], prompts: [], extensions: [], tools: [] },
    usage: { skills: [], extensions: [], tools: [] },
    performance: {
      session: { count: 0, tokens: 0, seconds: 0, tps: null },
      last10: { count: 0, tokens: 0, seconds: 0, tps: null },
      last100: { count: 0, tokens: 0, seconds: 0, tps: null },
    },
  };
  const lines = buildStatsLines(d, 1000);
  const text = lines.map((l) => l.text).join("\n");
  assert.ok(text.includes("usage (global"));
  assert.ok(text.includes("performance"));
  assert.ok(text.includes("no data"));
  const usageIdx = lines.findIndex((l) => l.text.includes("usage (global"));
  assert.ok(usageIdx >= 0);
  assert.ok(lines[usageIdx + 1].text.includes("(none)"), "empty usage section should say (none)");
});

test("buildStatsColumns: empty usage/tools/perf placeholders", () => {
  const d: StatsData = {
    model: "prov/mod",
    thinkingLevel: "high",
    sessionName: "my session",
    sessionId: "abc123",
    cwd: "/home/u/proj",
    status: "streaming",
    hasPending: true,
    contextTokens: 12400,
    contextWindow: 200000,
    contextPercent: 6.2,
    systemPrompt: {
      total: 2100,
      sections: [
        { name: "preamble", tokens: 1200, chars: 4800 },
        { name: "skills", tokens: 480, chars: 1920 },
        { name: "project_context", tokens: 320, chars: 1280 },
        { name: "docs", tokens: 90, chars: 360 },
      ],
    },
    contextFiles: [
      { path: "AGENTS.md", tokens: 300 },
      { path: ".pi/EXTRA.md", tokens: 20 },
    ],
    skillsInPrompt: 6,
    messages: {
      count: 70,
      tokens: 10300,
      roles: [
        { role: "assistant", count: 30, tokens: 4000 },
        { role: "toolResult", count: 28, tokens: 6100 },
        { role: "user", count: 12, tokens: 200 },
      ],
    },
    totals: { input: 1_200_000, output: 180_000, cacheRead: 3_400_000, cacheWrite: 90_000, cost: 4.2, turns: 132 },
    lastTurn: { input: 1200, output: 450, cacheRead: 11800, reasoning: 120 },
    resources: {
      contextFiles: [
        { name: "AGENTS.md", path: "AGENTS.md", scope: "" },
        { name: ".pi/EXTRA.md", path: ".pi/EXTRA.md", scope: "" },
      ],
      skills: [
        { name: "alpha", path: "~/s/alpha", scope: "user" },
        { name: "beta", path: "./.pi/skills/beta", scope: "project" },
      ],
      prompts: [{ name: "commit", path: "~/p/commit", scope: "user" }],
      extensions: [{ name: "stats.ts", path: "~/e/stats.ts", scope: "user" }],
      tools: [],
    },
    usage: { skills: [], extensions: [], tools: [] },
    performance: {
      session: { count: 132, tokens: 180_000, seconds: 0, tps: null },
      last10: { count: 0, tokens: 0, seconds: 0, tps: null },
      last100: { count: 0, tokens: 0, seconds: 0, tps: null },
    },
  };
  const { left, right, footer } = buildStatsColumns(d, 60, 60);
  const leftText = left.map((l) => l.text).join("\n");
  const rightText = right.map((l) => l.text).join("\n");

  // LEFT: header, context, prompt sections, messages, tokens all intact
  assert.equal(left[0].text, "stats");
  assert.ok(leftText.includes("prov/mod"));
  assert.ok(leftText.includes("high"));
  assert.ok(leftText.includes("my session (abc123)"));
  assert.ok(leftText.includes("/home/u/proj"));
  assert.ok(leftText.includes("streaming"));
  assert.ok(leftText.includes("queued"));
  const barLine = left.find((l) => l.text.includes("200k"))!;
  assert.ok(barLine);
  assert.equal((barLine.text.match(/█/g) ?? []).length, 2); // 6% of 30 => 2 filled
  assert.ok(leftText.includes("~2.1k"));
  const spIdx = left.findIndex((l) => l.text === "system prompt sections");
  assert.ok(spIdx > 0);
  assert.ok(left[spIdx + 1].text.includes("preamble"));
  assert.ok(leftText.includes("skills (6)"));
  const ctxSectionIdx = left.findIndex((l) => l.text.includes("project_context"));
  assert.ok(left[ctxSectionIdx + 1].text.includes("AGENTS.md"));
  assert.ok(left[ctxSectionIdx + 2].text.includes(".pi/EXTRA.md"));
  assert.ok(leftText.includes("messages (70)"));
  assert.ok(leftText.includes("toolResult"));
  assert.ok(leftText.includes("1.2M"));
  assert.ok(leftText.includes("$4.20"));
  assert.ok(leftText.includes("last turn"));
  assert.ok(leftText.includes("↓450"));
  // performance with no data -> em-dash placeholder
  assert.ok(leftText.includes("performance (output tokens/s)"));
  assert.ok(leftText.includes("—"));

  // RIGHT: resources intact; tools + usage empty -> (none)
  assert.equal(right[0].text, "environment");
  assert.ok(rightText.includes("loaded resources"));
  assert.ok(rightText.includes("alpha, beta"));
  assert.ok(rightText.includes("/commit"));
  assert.ok(rightText.includes("stats.ts"));
  assert.ok(rightText.includes("tools (0)"));
  assert.ok(rightText.includes("(none)"), "empty tools/usage should say (none)");

  // footer hint
  assert.ok(footer.text.includes("esc"));
  assert.ok(footer.text.includes("refresh"));
});

test("buildStatsLines: idle without last turn, unknown context", () => {
  const base: StatsData = {
    model: "unknown",
    thinkingLevel: undefined,
    sessionName: undefined,
    sessionId: "id1",
    cwd: "/x",
    status: "idle",
    hasPending: false,
    contextTokens: null,
    contextWindow: 0,
    contextPercent: null,
    systemPrompt: { total: 0, sections: [] },
    contextFiles: [],
    skillsInPrompt: 0,
    messages: { count: 0, tokens: 0, roles: [] },
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    lastTurn: null,
    resources: { contextFiles: [], skills: [], prompts: [], extensions: [], tools: [] },
    usage: { skills: [], extensions: [], tools: [] },
    performance: {
      session: { count: 0, tokens: 0, seconds: 0, tps: null },
      last10: { count: 0, tokens: 0, seconds: 0, tps: null },
      last100: { count: 0, tokens: 0, seconds: 0, tps: null },
    },
  };
  const lines = buildStatsLines(base, 1000);
  const text = lines.map((l) => l.text).join("\n");
  assert.ok(text.includes("idle"));
  assert.ok(!text.includes("last turn"));
  assert.ok(text.includes("(none)"));
  assert.ok(lines.some((l) => l.text.includes("unknown")));
});

test("buildStatsLines: long resource lines wrap at width", () => {
  const d: StatsData = {
    ...({} as StatsData),
    model: "m/x",
    thinkingLevel: undefined,
    sessionName: undefined,
    sessionId: "i",
    cwd: "/x",
    status: "idle",
    hasPending: false,
    contextTokens: 10,
    contextWindow: 100,
    contextPercent: 10,
    systemPrompt: { total: 1, sections: [{ name: "preamble", tokens: 1, chars: 4 }] },
    contextFiles: [],
    skillsInPrompt: 0,
    messages: { count: 1, tokens: 1, roles: [{ role: "user", count: 1, tokens: 1 }] },
    totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    lastTurn: null,
    resources: {
      contextFiles: [],
      skills: [],
      prompts: [],
      extensions: [1, 2, 3, 4].map((i) => ({ name: `ext-number-${i}.ts`, path: `/e/e${i}.ts`, scope: "user" })),
      tools: [],
    },
    usage: { skills: [], extensions: [], tools: [] },
    performance: {
      session: { count: 0, tokens: 0, seconds: 0, tps: null },
      last10: { count: 0, tokens: 0, seconds: 0, tps: null },
      last100: { count: 0, tokens: 0, seconds: 0, tps: null },
    },
  };
  const wide = buildStatsLines(d, 400);
  const extLineWide = wide.find((l) => l.text.includes("ext-number-1"))!;
  assert.ok(extLineWide.text.includes("ext-number-4")); // one line when wide
  // two-column layout: the right cell is half the box, so 70 cols still wraps
  const narrow = buildStatsLines(d, 70);
  const firstExt = narrow.find((l) => l.text.includes("ext-number-1"))!;
  assert.ok(firstExt, "first wrapped extension line missing");
  assert.ok(!firstExt.text.includes("ext-number-4")); // wrapped
  assert.ok(narrow.some((l) => l.text.includes("ext-number-4")));
});

test("collectLoadedResources: project skills, context files, prompts, extensions", () => {
  const cwd = makeTmp("res");
  fs.mkdirSync(path.join(cwd, ".pi/skills/demokill"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi/skills/demokill/SKILL.md"),
    "---\nname: demokill\ndescription: A demo skill\n---\nbody\n",
  );
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# agents\n");
  fs.mkdirSync(path.join(cwd, ".pi/extensions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi/extensions/myext.ts"), "export default function () {}\n");
  const cfgDir = makeTmp("cfg");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "ext2.ts"), "export default function () {}\n");

  const pi = fakePi({
    getCommands: () => [
      {
        name: "commit",
        source: "prompt",
        sourceInfo: { path: path.join(cwd, ".pi/prompts/commit.md"), scope: "project", source: "file" },
      },
    ],
    getSettings: () => ({ extensions: [cfgDir] }),
  });

  const res = collectLoadedResources(pi, cwd);
  assert.ok(res.contextFiles.some((f) => f.name.endsWith("AGENTS.md")));
  const demo = res.skills.find((s) => s.name === "demokill")!;
  assert.ok(demo);
  assert.equal(demo.scope, "project");
  assert.ok(res.prompts.some((p) => p.name === "commit"));
  assert.ok(res.extensions.some((e) => e.name === "myext.ts" && e.scope === "project"));
  assert.ok(res.extensions.some((e) => e.name === "ext2.ts" && e.scope === "path"));
});

test("collectStats: full snapshot from fake ctx", () => {
  const cwd = makeTmp("snap");
  fs.mkdirSync(path.join(cwd, ".pi/skills/demokill"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi/skills/demokill/SKILL.md"),
    "---\nname: demokill\ndescription: A demo skill\n---\nbody\n",
  );
  const agentsPath = path.join(cwd, "AGENTS.md");
  fs.writeFileSync(agentsPath, "x".repeat(400));

  const entries = [userEntry("u1", null, "hello"), assistantEntry("a1", "u1", fullUsage, "reply")];
  const ctx: StatsContextLike = {
    mode: "tui",
    cwd,
    model: { provider: "prov", id: "mod", contextWindow: 200000 },
    thinkingLevel: "high",
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
    getSystemPrompt: () =>
      ["You are a test agent.", "", "<project_context>", "x".repeat(400), "</project_context>", "", "<skills>", "skill list", "</skills>"].join("\n"),
    getSystemPromptOptions: () => ({
      cwd,
      contextFiles: [{ path: agentsPath, content: "x".repeat(400) }],
      skills: [],
    }),
    sessionManager: {
      getEntries: () => entries as never,
      getSessionId: () => "abc123",
      getSessionFile: () => "/tmp/s.jsonl",
      getSessionName: () => "\u001b[36mtest session\u001b[0m",
    },
  };
  const d = collectStats(fakePi({ getSettings: () => ({ extensions: [] }) }), ctx);

  assert.equal(d.model, "prov/mod");
  assert.equal(d.thinkingLevel, "high");
  assert.equal(d.sessionId, "abc123");
  assert.equal(d.sessionName, "test session"); // ANSI from the stored name stripped
  assert.equal(d.status, "idle");
  assert.equal(d.contextTokens, 1000);
  assert.equal(d.contextWindow, 200000);
  assert.equal(d.contextPercent, 0.5);
  const names = d.systemPrompt.sections.map((s) => s.name);
  assert.ok(names.includes("preamble"));
  assert.ok(names.includes("project_context"));
  assert.ok(names.includes("skills"));
  assert.ok(!names.includes("custom prompt"));
  assert.ok(d.systemPrompt.total > 0);
  const cf = d.contextFiles.find((f) => f.path === "AGENTS.md")!;
  assert.ok(cf);
  assert.equal(cf.tokens, 100); // 400 chars / 4
  assert.equal(d.totals.input, 100);
  assert.equal(d.totals.output, 50);
  assert.equal(d.totals.turns, 1);
  assert.ok(Math.abs(d.totals.cost - 0.00035) < 1e-9);
  assert.equal(d.lastTurn?.input, 100);
  assert.ok(d.messages.count >= 2);
  assert.ok(d.resources.skills.some((s) => s.name === "demokill"));
});

test("collectStats: streaming status + context fallback from last usage", () => {
  const cwd = makeTmp("snap2");
  const entries = [assistantEntry("a1", null, fullUsage, "reply")];
  const ctx: StatsContextLike = {
    mode: "tui",
    cwd,
    model: { provider: "p", id: "m" },
    isIdle: () => false,
    hasPendingMessages: () => true,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "sp",
    getSystemPromptOptions: () => ({ cwd }),
    sessionManager: {
      getEntries: () => entries as never,
      getSessionId: () => "s",
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
    },
  };
  const d = collectStats(fakePi(), ctx);
  assert.equal(d.status, "streaming");
  assert.equal(d.hasPending, true);
  assert.equal(d.contextTokens, 1155); // calculateContextTokens(lastUsage)
  assert.equal(d.contextWindow, 0);
});

test("default export registers /stats command", () => {
  let registered: { name: string; description?: string } | undefined;
  const onEvents: string[] = [];
  statsExt({
    registerCommand: (name: string, opts: { description?: string }) => {
      registered = { name, description: opts.description };
    },
    on: (event: string) => {
      onEvents.push(event);
      return () => {};
    },
  } as never);
  assert.equal(registered?.name, "stats");
  assert.ok(registered?.description?.toLowerCase().includes("dashboard") ?? false);
  assert.ok(onEvents.includes("input"), "factory must subscribe to input events");
  assert.ok(onEvents.includes("tool_execution_start"), "factory must subscribe to tool events");
});

// ------------------------------------------------- v1.1: usage + performance

test("attributeSkillInput: /skill:name parsing", () => {
  assert.equal(attributeSkillInput("/skill:demokill"), "demokill");
  assert.equal(attributeSkillInput("/skill:demokill do the thing"), "demokill");
  assert.equal(attributeSkillInput("/skill:a-b_c x"), "a-b_c");
  assert.equal(attributeSkillInput("/skill:"), null);
  assert.equal(attributeSkillInput("/skill:   "), null);
  assert.equal(attributeSkillInput("/skill"), null);
  assert.equal(attributeSkillInput("/stats"), null);
  assert.equal(attributeSkillInput("hello"), null);
  assert.equal(attributeSkillInput(""), null);
});

test("skillUseFromRead: only read of SKILL.md counts, index first, dir-name fallback", () => {
  const index = new Map<string, string>([["/real/skills/context-handover/SKILL.md", "context-handover"]]);
  assert.equal(skillUseFromRead("read", { path: "/real/skills/context-handover/SKILL.md" }, index), "context-handover");
  assert.equal(skillUseFromRead("read", { path: "/other/skills/foo/SKILL.md" }, index), "foo"); // fallback
  assert.equal(skillUseFromRead("read", { path: "/other/skills/foo/SKILL.md" }), "foo"); // no index
  assert.equal(skillUseFromRead("read", { path: "skills/foo/SKILL.md" }), "foo"); // relative resolved
  assert.equal(skillUseFromRead("read", { path: "/x/AGENTS.md" }, index), null);
  assert.equal(skillUseFromRead("read", { path: 42 } as never, index), null);
  assert.equal(skillUseFromRead("read", undefined, index), null);
  assert.equal(skillUseFromRead("bash", { path: "/other/skills/foo/SKILL.md" }, index), null);
  assert.equal(skillUseFromRead("edit", { path: "/other/skills/foo/SKILL.md" }, index), null);
});

test("UsageStore: record/merge across instances, persist, corrupt recovery", () => {
  const dir = makeTmp("store");
  const file = path.join(dir, "usage-stats.json");
  const s1 = new UsageStore(file);
  assert.deepEqual(s1.snapshot(), { version: 1, skills: {}, extensions: {}, tools: {} });

  const t0 = 1_700_000_000_000;
  s1.recordSkill("alpha", t0);
  s1.recordSkill("alpha", t0 + 1000);
  s1.recordExtension("/abs/lmstudio.ts", t0 + 2000);
  const snap = s1.snapshot();
  assert.equal(snap.skills.alpha?.count, 2);
  assert.equal(snap.skills.alpha?.firstSeen, new Date(t0).toISOString());
  assert.equal(snap.skills.alpha?.lastUsed, new Date(t0 + 1000).toISOString());
  assert.equal(snap.extensions["/abs/lmstudio.ts"]?.count, 1);

  // persisted to disk and visible to a second instance (cross-process safety)
  assert.ok(fs.existsSync(file));
  const s2 = new UsageStore(file);
  s2.recordSkill("alpha");
  assert.equal(s2.snapshot().skills.alpha?.count, 3);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(onDisk.skills.alpha.count, 3);

  // corrupt file → fresh start, no crash
  fs.writeFileSync(file, "not json{{");
  const s3 = new UsageStore(file);
  assert.deepEqual(s3.snapshot(), { version: 1, skills: {}, extensions: {}, tools: {} });
  s3.recordSkill("beta");
  assert.equal(new UsageStore(file).snapshot().skills.beta?.count, 1);

  // weird shapes survive normalization
  fs.writeFileSync(file, JSON.stringify({ version: 1, skills: { x: { count: "oops" } }, extensions: "nope" }));
  const s4 = new UsageStore(file);
  const bad = s4.snapshot();
  assert.equal(typeof bad.skills, "object");
  assert.equal(typeof bad.extensions, "object");
  s4.recordExtension("/e.ts");
  assert.equal(new UsageStore(file).snapshot().extensions["/e.ts"]?.count, 1);
});

test("usageStorePath: env override + default under agent dir", () => {
  const prev = process.env.PI_STATS_USAGE_FILE;
  try {
    process.env.PI_STATS_USAGE_FILE = "/tmp/custom-usage.json";
    assert.equal(usageStorePath(), "/tmp/custom-usage.json");
    delete process.env.PI_STATS_USAGE_FILE;
    const def = usageStorePath();
    assert.ok(def.endsWith(path.join("usage-stats.json")));
    assert.ok(!def.includes("custom-usage"));
  } finally {
    if (prev === undefined) delete process.env.PI_STATS_USAGE_FILE;
    else process.env.PI_STATS_USAGE_FILE = prev;
  }
});

test("trackExtensionRun/trackSkillUse: global file, path+fileURL keys, never throws", () => {
  const prev = process.env.PI_STATS_USAGE_FILE;
  const dir = makeTmp("track");
  const file = path.join(dir, "usage-stats.json");
  process.env.PI_STATS_USAGE_FILE = file;
  try {
    trackExtensionRun("/abs/lmstudio.ts");
    trackExtensionRun("file:///abs/lmstudio.ts"); // same key, file URL form
    trackSkillUse("demokill");
    trackExtensionRun(undefined); // must not throw
    trackExtensionRun(123 as never); // must not throw
    trackSkillUse(""); // must not throw
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(data.extensions["/abs/lmstudio.ts"].count, 2);
    assert.equal(data.skills.demokill.count, 1);
  } finally {
    if (prev === undefined) delete process.env.PI_STATS_USAGE_FILE;
    else process.env.PI_STATS_USAGE_FILE = prev;
  }
});

test("tokensPerSecond: span math, null on <2 items / zero span", () => {
  assert.equal(tokensPerSecond([]), null);
  assert.equal(tokensPerSecond([{ tokens: 500, timestamp: 1000 }]), null);
  assert.equal(tokensPerSecond([{ tokens: 100, timestamp: 0 }, { tokens: 100, timestamp: 10_000 }]), 20);
  assert.equal(tokensPerSecond([{ tokens: 100, timestamp: 5000 }, { tokens: 100, timestamp: 5000 }]), null); // zero span
  assert.equal(tokensPerSecond([{ tokens: 100, timestamp: 10_000 }, { tokens: 100, timestamp: 0 }]), null); // negative span
  // sums all tokens in the window
  assert.equal(
    tokensPerSecond([
      { tokens: 100, timestamp: 0 },
      { tokens: 200, timestamp: 5_000 },
      { tokens: 300, timestamp: 10_000 },
    ]),
    60,
  );
});

test("perfStats: session / last10 / last100 windows", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ tokens: 10, timestamp: i * 10_000 })); // 12 * 10s span
  const p = perfStats(items);
  assert.equal(p.session.count, 12);
  assert.equal(p.session.tokens, 120);
  assert.equal(p.session.seconds, 110); // first→last
  assert.ok(Math.abs(p.session.tps! - 120 / 110) < 1e-9);
  assert.equal(p.last10.count, 10);
  assert.equal(p.last10.tokens, 100);
  assert.equal(p.last10.seconds, 90);
  assert.equal(p.last100.count, 12); // fewer than 100 → all
  assert.deepEqual(p.last100, p.session);

  const empty = perfStats([]);
  assert.equal(empty.session.count, 0);
  assert.equal(empty.session.tps, null);
  assert.equal(empty.last10.tps, null);
  assert.equal(empty.last100.tps, null);
});

test("extractWorkItems: assistant+compaction+branch_summary with usage, no rollups", () => {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const entries: unknown[] = [
    { type: "message", id: "u1", parentId: null, timestamp: iso(0), message: { role: "user", content: "hi" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: iso(10_000), message: { role: "assistant", usage: { output: 50 } } },
    { type: "message", id: "a2", parentId: "a1", timestamp: iso(20_000), message: { role: "assistant" } }, // no usage
    { type: "compaction", id: "c1", parentId: "a2", timestamp: iso(30_000), usage: { output: 30 } },
    { type: "branch_summary", id: "b1", parentId: "c1", timestamp: iso(40_000), usage: { output: 20 } },
    { type: "usage", id: "s1", parentId: "b1", timestamp: iso(50_000), usage: { output: 1000 } }, // rollup: excluded
    { type: "message", id: "a3", parentId: "s1", timestamp: iso(60_000), message: { role: "assistant", usage: { output: 10 } } },
    { type: "message", id: "a4", parentId: "a3", timestamp: "garbage", message: { role: "assistant", usage: { output: 99 } } }, // bad ts: excluded
  ];
  const items = extractWorkItems(entries);
  assert.equal(items.length, 4);
  assert.equal(items[0].tokens, 50);
  assert.equal(items[0].timestamp, 10_000);
  assert.equal(items[1].tokens, 30);
  assert.equal(items[2].tokens, 20);
  assert.equal(items[3].tokens, 10);
});

test("formatDuration: s / m+s / h+m / d", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(42), "42s");
  assert.equal(formatDuration(59.6), "1m0s"); // rounds to 60s → minute branch
  assert.equal(formatDuration(295), "4m55s");
  assert.equal(formatDuration(3599), "59m59s");
  assert.equal(formatDuration(3600), "1h0m");
  assert.equal(formatDuration(3723), "1h2m");
  assert.equal(formatDuration(12_000), "3h20m");
  assert.equal(formatDuration(86_400), "1d");
  assert.equal(formatDuration(103_680), "1.2d");
});

test("formatAddedDate: UTC YYYY-MM-DD, null on missing", () => {
  assert.equal(formatAddedDate(Date.UTC(2026, 2, 1)), "2026-03-01");
  assert.equal(formatAddedDate(Date.UTC(2025, 11, 31, 23, 59, 59)), "2025-12-31");
  assert.equal(formatAddedDate(null), null);
  assert.equal(formatAddedDate(undefined), null);
  assert.equal(formatAddedDate(NaN), null);
});

test("fileIntroducedDate: birthtime of a real file, null for missing", () => {
  const dir = makeTmp("birth");
  const f = path.join(dir, "skill");
  const skill = path.join(f, "SKILL.md");
  fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(skill, "---\nname: x\n---\n");
  const ms = fileIntroducedDate(skill);
  assert.ok(ms != null, "expected a date for an existing file");
  assert.ok(ms > Date.now() - 60_000, "expected a recent date");
  assert.equal(fileIntroducedDate(path.join(dir, "missing.ts")), null);
});

test("collectStats: usage section from store + performance from entries", () => {
  const cwd = makeTmp("snap3");
  const storeDir = makeTmp("store3");
  const storeFile = path.join(storeDir, "usage-stats.json");
  new UsageStore(storeFile).recordSkill("demokill");
  new UsageStore(storeFile).recordExtension(path.join(cwd, ".pi/extensions/myext.ts"));

  fs.mkdirSync(path.join(cwd, ".pi/skills/demokill"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi/skills/demokill/SKILL.md"), "---\nname: demokill\ndescription: d\n---\nb\n");
  fs.mkdirSync(path.join(cwd, ".pi/extensions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi/extensions/myext.ts"), "export default function () {}\n");

  const iso = (ms: number): string => new Date(ms).toISOString();
  const t = Date.parse(iso(0));
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: iso(0), message: { role: "user", content: "hi" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: iso(10_000), message: { role: "assistant", usage: { input: 1, output: 100 } } },
    { type: "message", id: "a2", parentId: "a1", timestamp: iso(20_000), message: { role: "assistant", usage: { input: 1, output: 200 } } },
  ];
  void t;
  const ctx: StatsContextLike = {
    mode: "tui",
    cwd,
    model: { provider: "p", id: "m" },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "sp",
    getSystemPromptOptions: () => ({ cwd }),
    sessionManager: {
      getEntries: () => entries as never,
      getSessionId: () => "s3",
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
    },
  };
  const d = collectStats(fakePi(), ctx, { usageStorePath: storeFile });

  // usage: loaded skill + extension with global counts and introduced dates
  const skill = d.usage.skills.find((s) => s.name === "demokill");
  assert.ok(skill, "demokill listed in usage section");
  assert.equal(skill?.count, 1);
  assert.ok(skill?.added != null, "skill introduced date present");
  const ext = d.usage.extensions.find((e) => e.name === "myext.ts");
  assert.ok(ext, "myext.ts listed in usage section");
  assert.equal(ext?.count, 1);
  assert.ok(ext?.added != null, "extension introduced date present");

  // performance: 300 output tokens over 10s
  assert.equal(d.performance.session.count, 2);
  assert.equal(d.performance.session.tokens, 300);
  assert.equal(d.performance.session.seconds, 10);
  assert.equal(d.performance.session.tps, 30);
  assert.equal(d.performance.last10.count, 2);
  assert.deepEqual(d.performance.last100, d.performance.session);

  // default store path (no opts) must not throw and must not need the file
  const d2 = collectStats(fakePi(), ctx);
  assert.ok(d2.usage.skills.length >= 0);
});

test("factory: input + tool events increment the global usage store", () => {
  const prev = process.env.PI_STATS_USAGE_FILE;
  const dir = makeTmp("factory");
  const file = path.join(dir, "usage-stats.json");
  process.env.PI_STATS_USAGE_FILE = file;

  // a skill on disk that the index (cwd-based) will NOT find → dir-name fallback
  const skillDir = path.join(dir, "skills", "fallbackskill");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, "---\nname: fallbackskill\n---\n");

  const handlers = new Map<string, unknown[]>();
  let registered: { name: string; handler: unknown } | undefined;
  try {
    statsExt({
      registerCommand: (name: string, opts: { description?: string; handler: unknown }) => {
        registered = { name, handler: opts.handler };
      },
      on: (event: string, handler: unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
    } as never);
    assert.equal(registered?.name, "stats");

    const fire = (event: string, payload: unknown): void => {
      for (const h of handlers.get(event) ?? []) (h as (e: unknown) => void)(payload);
    };

    fire("input", { type: "input", text: "/skill:demokill now" });
    fire("input", { type: "input", text: "just talking" }); // no-op
    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: skillPath } });
    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "2", toolName: "read", args: { path: "/x/AGENTS.md" } }); // no-op
    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "3", toolName: "bash", args: { command: "ls" } }); // no-op

    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(data.skills.demokill?.count, 1);
    assert.equal(data.skills.fallbackskill?.count, 1);
    // v1.3: every tool execution is counted globally (skill reads included)
    assert.equal(data.tools.bash?.count, 1, "bash execution not counted");
    assert.equal(data.tools.read?.count, 2, "both read executions not counted");
  } finally {
    if (prev === undefined) delete process.env.PI_STATS_USAGE_FILE;
    else process.env.PI_STATS_USAGE_FILE = prev;
  }
});

// ------------------------------------------------- v1.3 tools + columns
test("parseToolList: parses - name: description lines", () => {
  const text = [
    "- read: Read file contents (relative or absolute)",
    "- bash: Execute bash commands (ls, grep, find, etc.)",
    "- server:tool: An MCP tool",
    "not a list line",
    "- missing colon",
  ].join("\n");
  assert.deepEqual(parseToolList(text), ["read", "bash", "server:tool"]);
  assert.deepEqual(parseToolList(undefined), []);
  assert.deepEqual(parseToolList(""), []);
  assert.deepEqual(parseToolList("   "), []);
});

test("parseNumstat: added/deleted lines, files, binary, renames; top sorted", () => {
  const out = "10\t2\tfile.ts\n0\t12\tgone.txt\n-\t-\tbinary.png\n5\t0\ta => b.md\n";
  const r = parseNumstat(out);
  assert.equal(r.added, 15);
  assert.equal(r.deleted, 14);
  assert.equal(r.files, 4);
  // top sorted by (added+deleted) desc, tie-break added desc: file.ts(12,10+) then gone.txt(12,0+)
  assert.deepEqual(r.top.map((f) => f.path), ["file.ts", "gone.txt", "a => b.md", "binary.png"]);
  assert.deepEqual(r.top[0], { path: "file.ts", added: 10, deleted: 2 });
  // binary: counted as a file, zero lines
  assert.deepEqual(r.top[3], { path: "binary.png", added: 0, deleted: 0 });
  assert.deepEqual(parseNumstat(""), { added: 0, deleted: 0, files: 0, top: [] });
});

test("parseUntrackedWc: sums lines, skips total lines (incl. xargs-splits)", () => {
  assert.deepEqual(parseUntrackedWc("      7 new.txt\n      3 other.md\n      10 total\n"), { files: 2, added: 10 });
  // xargs may spawn multiple wc processes → multiple `total` lines
  assert.deepEqual(parseUntrackedWc("      1 a\n      1 total\n      2 b\n      2 total\n"), { files: 2, added: 3 });
  assert.deepEqual(parseUntrackedWc(""), { files: 0, added: 0 });
});

test("buildStatsColumns: changes section (changes / not-repo / unavailable / pending)", () => {
  // pending: no git field yet → header + … (the probe fills in on the next frame)
  const pending = buildStatsColumns(dashboardData(), 40, 40);
  const ptext = pending.left.map((l) => l.text);
  const pidx = ptext.findIndex((t) => t.startsWith("changes (this session, git)"));
  assert.ok(pidx >= 0, "pending: header shown while loading");
  assert.equal(ptext[pidx + 1], "  …");

  const withGit: StatsData = {
    ...dashboardData(),
    git: {
      kind: "changes",
      changes: {
        added: 12,
        deleted: 3,
        files: 1,
        untracked: { files: 3, added: 89 },
        top: [
          { path: "stats.ts", added: 40, deleted: 2 },
          { path: "README.md", added: 15, deleted: 0 },
        ],
      },
    },
  };
  const cols = buildStatsColumns(withGit, 40, 40);
  const text = cols.left.map((l) => l.text);
  const idx = text.findIndex((t) => t.startsWith("changes (this session, git)"));
  assert.ok(idx >= 0, "changes header missing");
  assert.equal(text[idx + 1], "  +12  -3  · 1 file");
  assert.equal(text[idx + 2], "  +89 untracked (3 files)");
  assert.equal(text[idx + 3], "  top: stats.ts +40 -2 · README.md +15");
  // ordered between tokens and performance
  assert.ok(text.indexOf("tokens (session)") < idx);
  assert.ok(idx < text.indexOf("performance (output tokens/s)"));

  const notRepo = buildStatsColumns({ ...dashboardData(), git: { kind: "not-repo" } }, 40, 40);
  assert.ok(notRepo.left.some((l) => l.text === "  (not a git repo)"));

  const unavailable = buildStatsColumns({ ...dashboardData(), git: { kind: "unavailable", reason: "timeout" } }, 40, 40);
  assert.ok(unavailable.left.some((l) => l.text === "  (git unavailable)"));

  // zero changes: main line only (no untracked/top lines)
  const zero: StatsData = {
    ...dashboardData(),
    git: { kind: "changes", changes: { added: 0, deleted: 0, files: 0, untracked: { files: 0, added: 0 }, top: [] } },
  };
  const zcols = buildStatsColumns(zero, 40, 40);
  const ztext = zcols.left.map((l) => l.text);
  const zidx = ztext.findIndex((t) => t.startsWith("changes (this session, git)"));
  assert.equal(ztext[zidx + 1], "  +0  -0  · 0 files");
  assert.equal(ztext[zidx + 2], "");
});

test("UsageStore: tool counters persist; old files migrate", () => {
  const dir = makeTmp("toolstore");
  const file = path.join(dir, "usage-stats.json");
  new UsageStore(file).recordTool("bash", 1000);
  new UsageStore(file).recordTool("bash", 2000);
  new UsageStore(file).recordTool("read", 1500);
  const d = new UsageStore(file).load();
  assert.equal(d.tools.bash?.count, 2);
  assert.equal(d.tools.read?.count, 1);
  assert.ok(d.tools.bash?.firstSeen && d.tools.bash.lastUsed > d.tools.bash.firstSeen);
  // v1.1-era file without a "tools" key -> empty tools map, no crash
  const oldFile = path.join(dir, "old.json");
  fs.writeFileSync(oldFile, JSON.stringify({ version: 1, skills: {}, extensions: {} }));
  const migrated = new UsageStore(oldFile).load();
  assert.deepEqual(migrated.tools, {});
  assert.deepEqual(migrated.skills, {});
});

test("collectStats: tools from system prompt + global tool usage", () => {
  const dir = makeTmp("toolscoll");
  const storeFile = path.join(dir, "usage-stats.json");
  new UsageStore(storeFile).recordTool("bash");
  new UsageStore(storeFile).recordTool("bash");
  const sp = [
    "You are a coding agent.",
    "<tools>",
    "- read: Read file contents",
    "- bash: Execute bash commands (ls, grep, find, etc.)",
    "</tools>",
    "<rules>",
    "- use read",
    "</rules>",
  ].join("\n");
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "hi" } },
  ];
  const ctx: StatsContextLike = {
    mode: "tui",
    cwd: dir,
    model: { provider: "p", id: "m" },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    getSystemPrompt: () => sp,
    getSystemPromptOptions: () => ({ cwd: dir }),
    sessionManager: {
      getEntries: () => entries as never,
      getSessionId: () => "t1",
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
    },
  };
  const d = collectStats(fakePi(), ctx, { usageStorePath: storeFile });
  // loaded tools parsed from the final system prompt
  assert.deepEqual(d.resources.tools, ["read", "bash"]);
  // global tool usage: bash (2) before read (0), with introduced dates
  assert.deepEqual(d.usage.tools.map((t) => t.name), ["bash", "read"]);
  const bash = d.usage.tools.find((t) => t.name === "bash")!;
  assert.equal(bash.count, 2);
  assert.ok(bash.added, "built-in tool introduced date present");
  const read = d.usage.tools.find((t) => t.name === "read")!;
  assert.equal(read.count, 0);
  assert.ok(read.added, "built-in tool introduced date present");
});

// ------------------------------------------------- component smoke tests

function fakeTheme(): never {
  return {
    fg: (_token: string, s: string) => s,
    bg: (_token: string, s: string) => s,
  } as never;
}

function fakeTui(rows: number): never {
  // mirrors the real TUI: rows live on the terminal, the component must not rely on bounds
  return { requestRender: () => {}, terminal: { rows } } as never;
}

function tallData(skills: number, extensions: number): StatsData {
  const d = dashboardData();
  d.usage.skills = Array.from({ length: skills }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, count: 3 - (i % 3), added: "2026-01-01" }));
  d.usage.extensions = Array.from({ length: extensions }, (_, i) => ({ name: `ext-${String(i).padStart(2, "0")}.ts`, count: i % 4, added: "2026-02-01" }));
  return d;
}

function fakeKeybindings() {
  const map: Record<string, string> = {
    "\x1b[A": "tui.select.up",
    "\x1b[B": "tui.select.down",
    "\x1b[5~": "tui.select.pageUp",
    "\x1b[6~": "tui.select.pageDown",
    "\x1b": "tui.select.cancel",
  };
  return {
    matches: (data: string, action: string): boolean => {
      for (const [d, a] of Object.entries(map)) if (a === action && d === data) return true;
      return false;
    },
  } as never;
}

function dashboardData(): StatsData {
  return {
    model: "prov/mod",
    thinkingLevel: "high",
    sessionName: "sess",
    sessionId: "id",
    cwd: "/x",
    status: "streaming",
    hasPending: false,
    contextTokens: 50000,
    contextWindow: 200000,
    contextPercent: 25,
    systemPrompt: { total: 2000, sections: [{ name: "preamble", tokens: 2000, chars: 8000 }] },
    contextFiles: [],
    skillsInPrompt: 3,
    messages: {
      count: 12,
      tokens: 48000,
      roles: [{ role: "toolResult", count: 8, tokens: 40000 }, { role: "user", count: 4, tokens: 8000 }],
    },
    totals: { input: 1000, output: 500, cacheRead: 9000, cacheWrite: 100, cost: 0.1, turns: 6 },
    lastTurn: { input: 50000, output: 100 },
    resources: {
      contextFiles: [{ name: "AGENTS.md", path: "AGENTS.md", scope: "" }],
      skills: [{ name: "alpha", path: "/s/a", scope: "user" }],
      prompts: [],
      extensions: [{ name: "stats.ts", path: "/e/stats.ts", scope: "user" }],
      tools: ["read", "bash", "edit", "write"],
    },
    usage: {
      skills: [{ name: "alpha", count: 3, added: "2026-03-01" }],
      extensions: [{ name: "stats.ts", count: 7, added: "2026-07-09" }],
      tools: [
        { name: "read", count: 42, added: "2026-11-02" },
        { name: "bash", count: 17, added: "2026-11-02" },
        { name: "edit", count: 5, added: "2026-11-02" },
        { name: "write", count: 0, added: "2026-11-02" },
      ],
    },
    performance: {
      session: { count: 6, tokens: 500, seconds: 600, tps: 0.8 },
      last10: { count: 6, tokens: 500, seconds: 600, tps: 0.8 },
      last100: { count: 0, tokens: 0, seconds: 0, tps: null },
    },
  };
}

test("StatsDashboard: renders boxed dashboard, escape closes", () => {
  let doneCalled = 0;
  const comp = new StatsDashboard(fakeTheme(), fakeTui(60), fakeKeybindings(), dashboardData(), () => doneCalled++);
  const lines = comp.render(80);
  assert.ok(lines.length > 5);
  assert.ok(lines[0].startsWith("╭"));
  assert.ok(lines[0].endsWith("╮"));
  assert.ok(lines[lines.length - 1].startsWith("╰"));
  assert.ok(lines[lines.length - 1].endsWith("╯"));
  for (const l of lines.slice(1, -1)) assert.ok(l.startsWith("│"));
  // visible (ANSI-stripped) width must fit the box; raw length may carry reset codes
  const visible = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  for (const l of lines) assert.ok(visible(l).length <= 80, `line too long: ${JSON.stringify(l)}`);
  const text = lines.join("\n");
  assert.ok(text.includes("prov/mod"));
  assert.ok(text.includes("context window"));
  assert.ok(text.includes("loaded resources"));
  comp.handleInput?.("\x1b");
  assert.equal(doneCalled, 1);
});

test("StatsDashboard: two-column layout (session | environment) with divider borders", () => {
  const comp = new StatsDashboard(fakeTheme(), fakeTui(60), fakeKeybindings(), dashboardData(), () => {});
  const lines = comp.render(120);
  assert.ok(lines[0].includes("┬"), "top border must have the middle divider");
  assert.ok(lines[lines.length - 1].includes("┴"), "bottom border must have the middle divider");
  const bars = (s: string): number => (s.match(/│/g) ?? []).length;
  // title row: both group titles, same row, left of right
  const title = lines[1];
  assert.ok(title.includes("stats") && title.includes("environment"), "group titles missing");
  assert.ok(title.indexOf("stats") < title.indexOf("environment"));
  // content rows: left border + middle divider + right border
  for (const l of lines.slice(1, -2)) {
    assert.equal(bars(l), 3, `expected 3 borders in row: ${l}`);
  }
  assert.ok(lines.some((l) => l.includes("context window")), "left column content missing");
  assert.ok(lines.some((l) => l.includes("loaded resources")), "right column content missing");
  assert.ok(lines.some((l) => l.includes("tools (4)")), "tools section missing");
  // footer: full-width (only outer borders)
  const footer = lines[lines.length - 2];
  assert.equal(bars(footer), 2);
  assert.ok(footer.includes("esc/q close"));
});

test("StatsDashboard: box fits terminal, scrolls, bottom border always visible", () => {
  // rows=12 -> overlay maxHeight=floor(12*0.88)=10 -> box must be exactly 10 lines (2 borders + 8 content)
  const comp = new StatsDashboard(fakeTheme(), fakeTui(12), fakeKeybindings(), dashboardData(), () => {});
  const first = comp.render(80);
  assert.equal(first.length, 10, "box is exactly maxHeight rows (never sliced, bottom border survives)");
  assert.ok(first[0].startsWith("╭"));
  assert.ok(first[first.length - 1].startsWith("╰"), "bottom border present on first frame");
  const top0 = first[1];
  comp.handleInput?.("\x1b[B"); // down
  const after = comp.render(80);
  assert.equal(after.length, 10);
  assert.ok(after[after.length - 1].startsWith("╰"), "bottom border present after scroll");
  assert.notEqual(after[1], top0); // content moved
  // regression: scroll position must survive re-renders (overlay bounds are stale during render)
  const control = new StatsDashboard(fakeTheme(), fakeTui(12), fakeKeybindings(), dashboardData(), () => {});
  control.render(80);
  for (let i = 0; i < 4; i++) {
    comp.handleInput?.("\x1b[B");
    comp.render(80);
  }
  for (let i = 0; i < 5; i++) control.handleInput?.("\x1b[B"); // same 5 downs, no interleaved renders
  assert.deepEqual(comp.render(80), control.render(80), "interleaved renders must not reset scroll position");
  assert.notDeepEqual(comp.render(80), first, "scrolled frame differs from top");
  // clamped at bottom
  for (let i = 0; i < 500; i++) comp.handleInput?.("\x1b[B");
  const bottom = comp.render(80);
  assert.ok(bottom[bottom.length - 1].startsWith("╰"), "bottom border at max scroll");
  for (let i = 0; i < 500; i++) comp.handleInput?.("\x1b[B");
  assert.deepEqual(comp.render(80), bottom);
});

test("StatsDashboard: tall content — first frame fits maxHeight and can reach the footer", () => {
  const rows = 50; // overlay maxHeight = floor(50*0.88) = 44
  const comp = new StatsDashboard(fakeTheme(), fakeTui(rows), fakeKeybindings(), tallData(80, 30), () => {});
  const lines = comp.render(120);
  assert.ok(lines.length <= Math.floor(rows * 0.88), `first frame fits maxHeight (${lines.length} lines)`);
  assert.ok(lines[lines.length - 1].startsWith("╰"), "bottom border visible on first frame");
  // scroll to the very bottom (pageDown spam) — performance section + footer must become reachable
  for (let i = 0; i < 200; i++) comp.handleInput?.("\x1b[6~");
  const bottom = comp.render(120);
  assert.ok(bottom[bottom.length - 1].startsWith("╰"), "bottom border visible at max scroll");
  assert.ok(bottom.join("\n").includes("esc/q close"), "footer hint reachable by scrolling");
});

test("StatsDashboard: mouse wheel scrolls via handleMouse", () => {
  const comp = new StatsDashboard(fakeTheme(), fakeTui(50), fakeKeybindings(), tallData(60, 20), () => {});
  comp.render(120);
  const top = comp.render(120).join("\n");
  const down = comp.handleMouse?.({ type: "wheel", wheelDelta: 3, x: 5, y: 5, screenX: 5, screenY: 5, width: 120, height: 50, button: "none", shift: false, alt: false, ctrl: false } as never);
  assert.deepEqual(down, { handled: true, render: true });
  const scrolled = comp.render(120).join("\n");
  assert.notEqual(scrolled, top, "wheel down scrolled");
  const up = comp.handleMouse?.({ type: "wheel", wheelDelta: -100, x: 5, y: 5, screenX: 5, screenY: 5, width: 120, height: 50, button: "none", shift: false, alt: false, ctrl: false } as never);
  assert.deepEqual(up, { handled: true, render: true });
  assert.equal(comp.render(120).join("\n"), top, "wheel up clamped back to top");
  assert.equal(comp.handleMouse?.({ type: "click", button: "left", x: 5, y: 5, screenX: 5, screenY: 5, width: 120, height: 50, shift: false, alt: false, ctrl: false, clickCount: 1 } as never), undefined, "non-wheel mouse events ignored");
});

test("StatsDashboard: raw SGR wheel passthrough scrolls via handleInput", () => {
  const comp = new StatsDashboard(fakeTheme(), fakeTui(50), fakeKeybindings(), tallData(60, 20), () => {});
  comp.render(120);
  const top = comp.render(120).join("\n");
  comp.handleInput?.("\x1b[<65;10;5M"); // SGR wheel down (main-screen passthrough)
  const down = comp.render(120).join("\n");
  assert.notEqual(down, top, "SGR wheel down scrolled");
  comp.handleInput?.("\x1b[<64;10;5M"); // SGR wheel up
  assert.equal(comp.render(120).join("\n"), top, "SGR wheel up back to top");
  comp.handleInput?.("\x1b[<0;10;5M"); // left click press — must not scroll
  comp.handleInput?.("\x1b[<0;10;5m"); // left click release — must not scroll
  assert.equal(comp.render(120).join("\n"), top, "clicks do not scroll");
});

test("buildStatsLines: footer hint documents wheel scrolling", () => {
  const lines = buildStatsLines(dashboardData(), 120);
  const hint = lines[lines.length - 1];
  assert.ok(hint.text.includes("wheel"), `footer should mention wheel: ${hint.text}`);
});

test("StatsDashboard: live data refresh re-renders", () => {
  let comp: StatsDashboard;
  const done = () => {};
  const tui = fakeTui(60);
  comp = new StatsDashboard(fakeTheme(), tui, fakeKeybindings(), dashboardData(), done);
  const before = comp.render(100).join("\n");
  const d2 = dashboardData();
  d2.model = "other/newmodel";
  comp.setData(d2);
  const after = comp.render(100).join("\n");
  assert.ok(!before.includes("other/newmodel"));
  assert.ok(after.includes("other/newmodel"));
  comp.handleInput?.("r"); // manual refresh key does not throw
  comp.dispose?.();
});

// ====================== v1.5: last turn · MTP acceptance · perf rating ======================

test("lastTurnWindow: single most recent item vs the one before it", () => {
  const items = [
    { tokens: 100, timestamp: 0 },
    { tokens: 200, timestamp: 10_000 },
    { tokens: 300, timestamp: 30_000 },
  ];
  const last = lastTurnWindow(items);
  assert.equal(last.count, 1);
  assert.equal(last.tokens, 300);
  assert.equal(last.seconds, 20);
  assert.equal(last.tps, 15);
  const single = lastTurnWindow([{ tokens: 77, timestamp: 5 }]);
  assert.equal(single.count, 1);
  assert.equal(single.tokens, 77);
  assert.equal(single.seconds, 0);
  assert.equal(single.tps, null);
  const zeroSpan = lastTurnWindow([
    { tokens: 10, timestamp: 5 },
    { tokens: 20, timestamp: 5 },
  ]);
  assert.equal(zeroSpan.tps, null);
});

test("parseMtpStats: LM Studio draft-token (MTP) stats", () => {
  const body = {
    usage: { prompt_tokens: 61, completion_tokens: 108 },
    stats: {
      total_draft_tokens_count: 92,
      accepted_draft_tokens_count: 85,
      rejected_draft_tokens_count: 7,
      ignored_draft_tokens_count: 0,
    },
  };
  const m = parseMtpStats(body);
  assert.ok(m, "parses the stats object");
  assert.equal(m?.total, 92);
  assert.equal(m?.accepted, 85);
  assert.equal(m?.rejected, 7);
  assert.ok(Math.abs(m!.rate - 85 / 92) < 1e-9, "rate = accepted/total");
  assert.equal(parseMtpStats({ stats: {} }), null, "empty stats (1-token answer) → null");
  assert.equal(parseMtpStats({}), null, "missing stats → null");
  assert.equal(parseMtpStats("nope"), null, "non-object body → null");
  assert.equal(parseMtpStats({ stats: { total_draft_tokens_count: 0 } }), null, "total 0 → null");
});

test("PerfStore: tool durations persist, max tracked, invalid skipped, corrupt recovers", () => {
  const dir = makeTmp("perfstore");
  const file = path.join(dir, "perf-stats.json");
  const s = new PerfStore(file);
  const d1 = s.record("bash", 120);
  assert.equal(d1.tools.bash?.calls, 1);
  assert.equal(d1.tools.bash?.totalMs, 120);
  assert.equal(d1.tools.bash?.maxMs, 120);
  assert.ok(d1.tools.bash?.firstSeen && d1.tools.bash?.lastUsed, "timestamps set");
  const d2 = s.record("bash", 30);
  assert.equal(d2.tools.bash?.calls, 2);
  assert.equal(d2.tools.bash?.totalMs, 150);
  assert.equal(d2.tools.bash?.maxMs, 120, "max survives a smaller record");
  s.record("bash", -5);
  s.record("bash", Number.NaN);
  assert.equal(new PerfStore(file).snapshot().tools.bash?.calls, 2, "invalid durations not recorded");
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new PerfStore(file).snapshot(), { version: 1, tools: {} }, "corrupt → fresh");
  assert.equal(new PerfStore(file).avgMs("bash"), null);
});

test("staticSourceMetrics: bytes, pi.on count, per-frame TUI detection", () => {
  const src = 'import x from "y";\npi.on("a", h);\npi.on("b", h);\npi.on("c", h);\nctx.ui.custom(comp);\n';
  const m = staticSourceMetrics(src);
  assert.equal(m.subs, 3);
  assert.equal(m.tui, true);
  assert.equal(m.bytes, Buffer.byteLength(src));
  const plain = staticSourceMetrics('pi.registerCommand("c", {});\n');
  assert.equal(plain.subs, 0);
  assert.equal(plain.tui, false);
  assert.equal(staticSourceMetrics("tui.showOverlay(c);").tui, true);
  assert.equal(staticSourceMetrics("pi.registerComponent(c);").tui, true);
});

test("rateItem: deterministic 1–5 bands and weighted composite", () => {
  // cheapest possible extension: no measurements, tiny, one subscription
  const cheap = rateItem({ kind: "extension", name: "cheap.ts", calls: 0, avgMs: null, bytes: 1000, subscriptions: 1 });
  assert.equal(cheap.rating, 1);
  assert.deepEqual([cheap.duration, cheap.frequency, cheap.static], [1, 1, 1]);

  // heavy tool: 2.5 s/call, 1.5k calls, 30 KB impl
  const heavy = rateItem({ kind: "tool", name: "bash", calls: 1500, avgMs: 2500, bytes: 30_000 });
  assert.equal(heavy.rating, 4);
  assert.deepEqual([heavy.duration, heavy.frequency, heavy.static], [4, 4, 3]);

  // per-frame TUI extension bumps the static factor by one
  const ui = rateItem({ kind: "extension", name: "ui.ts", calls: 50, avgMs: 80, bytes: 4_000, subscriptions: 4, tuiPerFrame: true });
  assert.equal(ui.static, 4, "max(size=2, subs=3) + 1 for per-frame TUI");
  assert.equal(ui.rating, 2);

  // ceiling
  const max = rateItem({ kind: "tool", name: "x", calls: 50_000, avgMs: 60_000, bytes: 200_000 });
  assert.equal(max.rating, 5);
  assert.deepEqual([max.duration, max.frequency, max.static], [5, 5, 5]);

  // unknown bytes (dynamic/MCP tool, no impl file) → neutral static 3
  const unknown = rateItem({ kind: "tool", name: "mcp-tool", calls: 0, avgMs: null, bytes: null });
  assert.equal(unknown.static, 3);
});

test("buildStatsColumns: performance section shows last turn + mtp rows", () => {
  const d = dashboardData();
  d.performance.last = { count: 1, tokens: 300, seconds: 20, tps: 15 };
  d.mtp = { total: 123, accepted: 96, rejected: 27, ignored: 0, rate: 96 / 123 };
  const left = buildStatsColumns(d, 40, 40).left.map((l) => l.text);
  // NOTE: the session section also has a "last turn" token line — match the perf one
  const idx = left.findIndex((t) => t.startsWith("  last turn") && t.includes("tok/s"));
  assert.ok(idx > 0, "last turn perf row present");
  assert.ok(left[idx].includes("15.0 tok/s"), left[idx]);
  assert.ok(left[idx].includes("300 out"), left[idx]);
  const mtpIdx = left.findIndex((t) => t.startsWith("  mtp (lm studio)"));
  assert.ok(mtpIdx > idx, "mtp row after last turn");
  assert.ok(left[mtpIdx].includes("78%"), left[mtpIdx]);
  assert.ok(left[mtpIdx].includes("96/123"), left[mtpIdx]);

  // no data → rows absent
  const left2 = buildStatsColumns(dashboardData(), 40, 40).left.map((l) => l.text);
  assert.ok(!left2.some((t) => t.startsWith("  last turn") && t.includes("tok/s")), "no last turn perf row without data");
  assert.ok(!left2.some((t) => t.startsWith("  mtp (lm studio)")), "no mtp without data");
});

test("buildStatsColumns: perf rating section in RIGHT column", () => {
  const d = dashboardData();
  d.ratings = {
    extensions: [{ name: "stats.ts", rating: 2, avgMs: null, calls: 7 }],
    tools: [
      { name: "bash", rating: 4, avgMs: 2500, calls: 1500 },
      { name: "read", rating: 1, avgMs: null, calls: 42 },
    ],
  };
  const right = buildStatsColumns(d, 40, 40).right.map((l) => l.text);
  const idx = right.findIndex((t) => t.startsWith("perf rating"));
  assert.ok(idx > 0, "perf rating header");
  const after = right.slice(idx);
  const bashRel = after.findIndex((t) => t.includes("bash"));
  assert.ok(bashRel >= 0, "bash listed under perf rating");
  assert.ok(after[bashRel].includes("4"), after[bashRel]);
  assert.ok(after[bashRel].includes("2.5s"), "avg ms formatted: " + after[bashRel]);
  const readRel = after.findIndex((t) => t.includes("read"));
  assert.ok(readRel > 0, "read listed");
  assert.ok(!after[readRel].includes("/call"), "no /call suffix without duration data: " + after[readRel]);

  // no ratings data → no section
  const right2 = buildStatsColumns(dashboardData(), 40, 40).right.map((l) => l.text);
  assert.ok(!right2.some((t) => t.startsWith("perf rating")), "no perf rating without data");
});

test("factory: tool_execution_end records durations in the perf store", () => {
  const prevUsage = process.env.PI_STATS_USAGE_FILE;
  const prevPerf = process.env.PI_STATS_PERF_FILE;
  const dir = makeTmp("factory-perf");
  process.env.PI_STATS_USAGE_FILE = path.join(dir, "usage.json");
  const perfFile = path.join(dir, "perf-stats.json");
  process.env.PI_STATS_PERF_FILE = perfFile;
  const handlers = new Map<string, unknown[]>();
  try {
    statsExt({
      registerCommand: () => {},
      on: (event: string, handler: unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
    } as never);
    const fire = (event: string, payload: unknown): void => {
      for (const h of handlers.get(event) ?? []) (h as (e: unknown) => void)(payload);
    };
    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: null, isError: false, durationMs: 250 });
    fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "/x" } });
    // no durationMs → wall-clock fallback (≥1 ms, sub-millisecond floor)
    fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: null, isError: false });
    // orphan end without durationMs → not recorded
    fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "zz", toolName: "write", result: null, isError: false });
    const d = JSON.parse(fs.readFileSync(perfFile, "utf-8"));
    assert.equal(d.tools.bash?.calls, 1);
    assert.equal(d.tools.bash?.totalMs, 250);
    assert.equal(d.tools.bash?.maxMs, 250);
    assert.equal(d.tools.read?.calls, 1, "wall-clock fallback recorded");
    assert.ok((d.tools.read?.totalMs ?? 0) >= 1, "fallback floored at 1 ms");
    assert.equal(d.tools.write, undefined, "orphan end without durationMs not recorded");
  } finally {
    if (prevUsage === undefined) delete process.env.PI_STATS_USAGE_FILE;
    else process.env.PI_STATS_USAGE_FILE = prevUsage;
    if (prevPerf === undefined) delete process.env.PI_STATS_PERF_FILE;
    else process.env.PI_STATS_PERF_FILE = prevPerf;
  }
});

/* ------------------------------------------------------------------- */
/* v1.5.1 — table column alignment (first column width is dynamic)      */
/* ------------------------------------------------------------------- */

test("columnWidth: min when labels are short, longest+gap when long", () => {
  assert.equal(columnWidth([]), 14);
  assert.equal(columnWidth(["bash", "read", "write"]), 14);
  assert.equal(columnWidth(["session-name-border.ts"]), 24); // 22 + 2
  assert.equal(columnWidth(["session", "last 100"], 10), 10);
  assert.equal(columnWidth(["mtp (lm studio)"], 10), 17); // 15 + 2
});

/** every line must contain `marker` at the SAME index (column alignment) */
function assertAligned(lines: string[], marker: string, label: string): void {
  assert.ok(lines.length >= 2, `${label}: need >=2 lines, got ${lines.length}`);
  const idx = lines.map((l) => l.indexOf(marker));
  assert.ok(
    idx.every((i) => i >= 0),
    `${label}: every line must contain "${marker}":\n` + lines.map((l, i) => `  [${i}] ${l}`).join("\n"),
  );
  assert.ok(
    new Set(idx).size === 1,
    `${label}: "${marker}" must start at the same index on every row:\n` +
      lines.map((l, i) => `  [${i}] idx=${idx[i]}  ${l}`).join("\n"),
  );
}

test("buildStatsColumns: usage table stays aligned with long names", () => {
  const d = dashboardData();
  d.usage.skills = [
    { name: "very-long-skill-name-aaaaaaaaaa", count: 3, added: "2026-01-01" },
    { name: "tiny", count: 1, added: "2026-01-02" },
  ];
  d.usage.extensions = [{ name: "session-name-border.ts", count: 6, added: "2026-01-03" }];
  d.usage.tools = [
    { name: "mcp__context7__resolve-library-id", count: 42, added: "2026-01-04" },
    { name: "bash", count: 9, added: "2026-01-05" },
  ];
  const right = buildStatsColumns(d, 60, 120).right.map((l) => l.text);
  const start = right.indexOf("usage (global · all sessions)");
  assert.ok(start >= 0, "usage header present");
  const rows = right.slice(start + 1).filter((l) => l.includes("added "));
  assert.ok(rows.length >= 5, "usage rows present: " + rows.join(" | "));
  assertAligned(rows, "added ", "usage table");
});

test("buildStatsColumns: perf rating table stays aligned with long names", () => {
  const d = dashboardData();
  d.ratings = {
    extensions: [
      { name: "session-name-border.ts", rating: 2, avgMs: null, calls: 6 },
      { name: "stats.ts", rating: 2, avgMs: null, calls: 7 },
    ],
    tools: [
      { name: "mcp__context7__resolve-library-id", rating: 3, avgMs: 250, calls: 100 },
      { name: "bash", rating: 4, avgMs: 2500, calls: 1500 },
    ],
  };
  const right = buildStatsColumns(d, 60, 120).right.map((l) => l.text);
  const start = right.findIndex((t) => t.startsWith("perf rating"));
  assert.ok(start >= 0, "perf rating header present");
  const rows = right.slice(start + 1).filter((l) => l.includes("runs"));
  assert.ok(rows.length >= 4, "rating rows present: " + rows.join(" | "));
  assertAligned(rows, " runs", "perf rating table");
});

test("buildStatsColumns: performance table stays aligned incl. the mtp row", () => {
  const d = dashboardData();
  d.performance.last = { count: 1, tokens: 300, seconds: 20, tps: 15 };
  d.performance.last100 = { count: 6, tokens: 500, seconds: 600, tps: 0.8 };
  d.mtp = { total: 123, accepted: 96, rejected: 27, ignored: 0, rate: 96 / 123 };
  const left = buildStatsColumns(d, 60, 60).left.map((l) => l.text);
  const start = left.indexOf("performance (output tokens/s)");
  assert.ok(start >= 0, "performance header present");
  const rows: string[] = [];
  for (let i = start + 1; i < left.length; i++) {
    if (left[i].trim() === "") break;
    rows.push(left[i]);
  }
  assert.ok(rows.length >= 5, "perf rows (session/10/100/last/mtp) present: " + rows.join(" | "));
  assertAligned(rows, "· ", "performance table");
  // mtp row keeps its content
  const mtp = rows.find((l) => l.includes("mtp (lm studio)"));
  assert.ok(mtp?.includes("96/123") && mtp?.includes("78%"), "mtp content intact: " + mtp);
});

test("buildStatsColumns: section + role label tables stay aligned with long labels", () => {
  const d = dashboardData();
  d.systemPrompt.sections = [
    { name: "current_session_info", tokens: 1200, chars: 4800 },
    { name: "tools", tokens: 800, chars: 3200 },
  ];
  d.systemPrompt.total = 2000;
  d.messages = {
    count: 12,
    tokens: 48000,
    roles: [
      { role: "compactionSummary", count: 1, tokens: 40000 },
      { role: "user", count: 4, tokens: 8000 },
    ],
  };
  const left = buildStatsColumns(d, 60, 60).left.map((l) => l.text);
  const secStart = left.indexOf("system prompt sections");
  const secRows: string[] = [];
  for (let i = secStart + 1; i < left.length; i++) {
    if (left[i].trim() === "") break;
    secRows.push(left[i]);
  }
  assert.ok(secRows.length >= 2, "section rows present: " + secRows.join(" | "));
  assertAligned(secRows, "~", "system prompt section table");
  const roleStart = left.indexOf("messages (12)");
  const roleRows: string[] = [];
  for (let i = roleStart + 1; i < left.length; i++) {
    if (left[i].trim() === "") break;
    roleRows.push(left[i]);
  }
  assert.ok(roleRows.length >= 2, "role rows present: " + roleRows.join(" | "));
  assertAligned(roleRows, "~", "messages role table");
});

console.log(`\n${passed} tests passed`);
