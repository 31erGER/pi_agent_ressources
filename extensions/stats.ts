/**
 * stats — live session dashboard for pi.
 *
 * Registers `/stats`: opens a boxed, scrollable overlay dashboard (NOT in the chat
 * flow, persists nothing to the session). Shows:
 *   - context window: usage / window / % with a bar, and a breakdown of what is in
 *     the window (system prompt vs. messages, with per-role message detail)
 *   - system prompt sections: per-section token estimates (preamble, docs,
 *     project_context incl. per-file sizes, skills, cwd, custom sections)
 *   - tokens (session): input / output / cache read / cache write / cost / turns,
 *     plus the last turn's usage
 *   - loaded resources: context files, skills, prompts, extensions (same discovery
 *     rules as the core loader, mirroring reload-resources.ts)
 *   - tools: the tools actually loaded for this session (parsed from the final
 *     system prompt's <tools> section, so dynamic/MCP tools are included)
 *   - usage (global): per-skill / per-extension / per-tool counters across ALL
 *     sessions plus the date each was introduced (persisted in
 *     ~/.pi/agent/usage-stats.json, overridable via PI_STATS_USAGE_FILE; sibling
 *     extensions self-report via trackExtensionRun; every tool_execution_start is
 *     counted via trackToolUse)
 *
 * Layout (v1.3): two columns split by a middle border divider — LEFT = live
 * session state (context, prompt sections, messages, tokens, performance),
 * RIGHT = environment (loaded resources, tools, global usage).
 *   - performance: output tokens/s for the whole session, last 10 and last 100 turns
 *   - session/model info: model, thinking level, session name/id, cwd, status
 *
 * Usable WHILE the agent works: extension commands execute immediately even during
 * streaming (AgentSession.prompt() handles them before queueing), and the overlay
 * subscribes to message/turn/agent/session events to refresh live (throttled).
 *
 * Usage tracking is process-wide: input ("/skill:x") and tool_execution_start
 * (read of SKILL.md) listeners are registered at load time, not just while the
 * dashboard is open. Extension commands are invisible to global listeners (they
 * short-circuit before the input event), so each extension self-reports one line:
 *   trackExtensionRun(import.meta.url)
 *
 * Keys:  esc/q close · ↑↓/pgup/pgdn/wheel scroll · r force refresh
 *
 * Display-only: no sendMessage/appendEntry/waitForIdle/abort. Pure core is exported
 * and unit-tested (see ~/.pi/agent/projects/stats-dashboard/test/stats-core.test.ts).
 *
 * Auto-loaded from ~/.pi/agent/extensions/.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext,
  calculateContextTokens,
  estimateTokens,
  getAgentDir,
  getLastAssistantUsage,
  loadProjectContextFiles,
  loadSkills,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeybindingsManager,
  type OverlayHandle,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

// ------------------------------------------------------------------ types

export type ColorRole = "default" | "dim" | "accent" | "success" | "warning" | "error";

export interface StatsLine {
  text: string;
  color: ColorRole;
}

/** Structural subset of pi-ai's Usage (session entries carry the full shape). */
export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SectionStat {
  name: string;
  tokens: number;
  chars: number;
}

export interface RoleStat {
  role: string;
  count: number;
  tokens: number;
}

export interface ResourceItem {
  name: string;
  path: string;
  scope: string;
  /** Resolved absolute path (usage-store key + introduced date). */
  resolved?: string;
}

export interface LoadedResources {
  contextFiles: ResourceItem[];
  skills: ResourceItem[];
  prompts: ResourceItem[];
  extensions: ResourceItem[];
  /** Tool names from the final system prompt's <tools> section (prompt-derived). */
  tools: string[];
}

export interface StatsData {
  model: string;
  thinkingLevel: string | undefined;
  sessionName: string | undefined;
  sessionId: string;
  cwd: string;
  status: "streaming" | "idle";
  hasPending: boolean;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  systemPrompt: { sections: SectionStat[]; total: number };
  contextFiles: { path: string; tokens: number }[];
  skillsInPrompt: number;
  messages: { count: number; tokens: number; roles: RoleStat[] };
  totals: UsageTotals;
  lastTurn: UsageLike | null;
  resources: LoadedResources;
  usage: UsageSection;
  performance: PerformanceSection;
}

/** One tracked record in the global usage store. */
export interface UsageRecord {
  count: number;
  firstSeen: string;
  lastUsed: string;
}

/** Shape of the global usage store file (~/.pi/agent/usage-stats.json). */
export interface UsageData {
  version: number;
  skills: Record<string, UsageRecord>;
  extensions: Record<string, UsageRecord>;
  tools: Record<string, UsageRecord>;
}

/** A listed skill/extension with its global counter + introduced date. */
export interface UsageItem {
  name: string;
  count: number;
  added: string | null;
}

export interface UsageSection {
  skills: UsageItem[];
  extensions: UsageItem[];
  tools: UsageItem[];
}

/** A timestamped amount of model-generated tokens (assistant/compaction/branch). */
export interface WorkItem {
  tokens: number;
  timestamp: number;
}

export interface PerfWindow {
  count: number;
  tokens: number;
  seconds: number;
  tps: number | null;
}

export interface PerformanceSection {
  session: PerfWindow;
  last10: PerfWindow;
  last100: PerfWindow;
}

export interface CollectStatsOptions {
  /** Override the global usage store file (tests). */
  usageStorePath?: string;
}

/** Structural subset of ExtensionAPI needed to list loaded resources. */
export interface ResourcesLike {
  getCommands(): {
    name: string;
    source: string;
    sourceInfo: { path: string; scope?: string; source?: string };
  }[];
  getSettings(): { extensions?: unknown };
}

/** Structural subset of ExtensionCommandContext needed to snapshot stats. */
export interface StatsContextLike {
  mode: string;
  cwd: string;
  model: { provider: string; id: string; contextWindow?: number } | undefined;
  thinkingLevel?: string;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getSystemPrompt(): string;
  getSystemPromptOptions(): BuildSystemPromptOptions;
  sessionManager: {
    getEntries(): SessionEntry[];
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
  };
}

// ----------------------------------------------------------------- formatting

/** Token count formatting in the style of pi's built-in footer (no trailing ".0"). */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 0) return `-${formatNumber(-n)}`;
  if (n < 1_000) return Math.round(n).toString();
  if (n < 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

export function formatCost(c: number): string {
  if (!Number.isFinite(c)) return "?";
  return `$${c.toFixed(2)}`;
}

/** Progress bar: `percent` clamped to 0..100 over `width` columns. */
export function bar(percent: number, width: number): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Estimate tokens for a plain text blob (pi's conservative chars/4 heuristic). */
export function textTokens(text: string): number {
  if (!text) return 0;
  return estimateTokens({ role: "system", content: text, timestamp: 0 } as Parameters<typeof estimateTokens>[0]);
}

/** Per-role counts + estimated tokens for a list of context messages. Sorted by tokens desc. */
export function roleBreakdown(messages: readonly unknown[]): RoleStat[] {
  const map = new Map<string, RoleStat>();
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    if (typeof role !== "string") continue;
    let tokens = 0;
    try {
      tokens = estimateTokens(m as Parameters<typeof estimateTokens>[0]);
    } catch {
      tokens = 0;
    }
    const r = map.get(role) ?? { role, count: 0, tokens: 0 };
    r.count += 1;
    r.tokens += tokens;
    map.set(role, r);
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count);
}

const SECTION_TAG = /<([a-z][a-z0-9_-]*)>\n([\s\S]*?)\n<\/\1>/g;

/**
 * Split a final system prompt into named sections. pi wraps every structured
 * section (except the untagged preamble) as `<name>\ncontent\n</name>`; a forced
 * custom prompt has no tags. Inner tags with attributes (e.g.
 * `<project_instructions path="...">`) cannot match the tag pattern.
 */
export function parseSystemPromptSections(prompt: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!prompt) return out;
  const tagged: { name: string; text: string; start: number; end: number }[] = [];
  for (const m of prompt.matchAll(SECTION_TAG)) {
    tagged.push({ name: m[1], text: m[2], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  if (tagged.length === 0) {
    out["custom prompt"] = prompt;
    return out;
  }
  const outside: string[] = [];
  let pos = 0;
  for (const t of tagged) {
    outside.push(prompt.slice(pos, t.start));
    out[t.name] = t.text;
    pos = t.end;
  }
  outside.push(prompt.slice(pos));
  const preamble = outside.join("").trim();
  if (preamble) out.preamble = preamble;
  return out;
}

/** Named system prompt sections → token estimates, sorted by tokens desc. */
export function sectionStats(sections: Record<string, string | null | undefined>): SectionStat[] {
  const out: SectionStat[] = [];
  for (const [name, text] of Object.entries(sections)) {
    if (!text) continue;
    out.push({ name, tokens: textTokens(text), chars: text.length });
  }
  out.sort((a, b) => b.tokens - a.tokens);
  return out;
}

/**
 * Sum usage over session entries, with the same semantics as pi's per-session
 * footer: assistant message usage + compaction / branch_summary / usage entries.
 */
export function sumSessionUsage(entries: readonly unknown[]): UsageTotals {
  const t: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const entry = e as {
      type?: unknown;
      usage?: UsageLike;
      message?: { role?: unknown; usage?: UsageLike };
    };
    let u: UsageLike | undefined;
    if (entry.type === "message") {
      const m = entry.message;
      if (m && m.role === "assistant" && m.usage) u = m.usage;
    } else if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
      u = entry.usage;
    }
    if (!u) continue;
    t.input += u.input ?? 0;
    t.output += u.output ?? 0;
    t.cacheRead += u.cacheRead ?? 0;
    t.cacheWrite += u.cacheWrite ?? 0;
    t.cost += u.cost?.total ?? 0;
    t.turns += 1;
  }
  return t;
}

/** Clamp a scroll position into [0, contentHeight - viewportHeight]. */
export function clampScroll(top: number, delta: number, contentHeight: number, viewportHeight: number): number {
  const max = Math.max(0, contentHeight - viewportHeight);
  return Math.max(0, Math.min(max, top + delta));
}

// ------------------------------------------- v1.1: global usage + performance

/** Global usage store location (PI_STATS_USAGE_FILE overrides for tests). */
export function usageStorePath(): string {
  const env = process.env.PI_STATS_USAGE_FILE;
  if (env && env.length > 0) return path.resolve(env);
  return path.join(getAgentDir(), "usage-stats.json");
}

function asRecordMap(v: unknown): Record<string, UsageRecord> {
  const out: Record<string, UsageRecord> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
      const r = raw as UsageRecord | undefined;
      const count =
        r && typeof r.count === "number" && Number.isFinite(r.count) ? Math.max(0, Math.floor(r.count)) : 0;
      const zero = new Date(0).toISOString();
      out[k] = {
        count,
        firstSeen: r && typeof r.firstSeen === "string" ? r.firstSeen : zero,
        lastUsed: r && typeof r.lastUsed === "string" ? r.lastUsed : zero,
      };
    }
  }
  return out;
}

function normalizeUsageData(parsed: unknown): UsageData {
  const p = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  return {
    version: 1,
    skills: asRecordMap(p.skills),
    extensions: asRecordMap(p.extensions),
    // v1.3 migration: pre-tools store files simply have no "tools" key
    tools: asRecordMap(p.tools),
  };
}

/**
 * Global (across sessions/processes) usage counters. Read-modify-write per record:
 * the file is the single source of truth, so separate pi processes (TUI + RPC) and
 * sibling extensions importing the same helpers can never diverge silently. A
 * corrupt or missing file resets to empty instead of crashing the caller.
 */
export class UsageStore {
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ? path.resolve(filePath) : usageStorePath();
  }

  load(): UsageData {
    try {
      return normalizeUsageData(JSON.parse(fs.readFileSync(this.filePath, "utf-8")));
    } catch {
      return { version: 1, skills: {}, extensions: {}, tools: {} };
    }
  }

  snapshot(): UsageData {
    return this.load();
  }

  private record(kind: "skills" | "extensions" | "tools", key: string, now: number): void {
    const data = this.load();
    const prev = data[kind][key];
    const iso = new Date(now).toISOString();
    data[kind][key] = prev
      ? { count: prev.count + 1, firstSeen: prev.firstSeen, lastUsed: iso }
      : { count: 1, firstSeen: iso, lastUsed: iso };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch {
      // never break the caller's flow over a stats counter
    }
  }

  recordSkill(name: string, now: number = Date.now()): void {
    if (name) this.record("skills", name, now);
  }

  recordExtension(key: string, now: number = Date.now()): void {
    if (key) this.record("extensions", key, now);
  }

  recordTool(name: string, now: number = Date.now()): void {
    if (name) this.record("tools", name, now);
  }
}

/** Extract the skill name from an explicit `/skill:name` input (or null). */
export function attributeSkillInput(text: string): string | null {
  if (typeof text !== "string" || !text.startsWith("/skill:")) return null;
  const rest = text.slice(7);
  const spaceIndex = rest.indexOf(" ");
  const name = (spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)).trim();
  if (!name || name.startsWith("/")) return null;
  return name;
}

/**
 * Attribute a tool execution to a skill: only `read` of a SKILL.md counts
 * (the agent consulting the skill). `index` maps resolved SKILL.md paths to
 * skill names (frontmatter name); falls back to the skill directory name.
 */
export function skillUseFromRead(
  toolName: string,
  args: unknown,
  index?: ReadonlyMap<string, string>,
): string | null {
  if (toolName !== "read") return null;
  const p = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
  if (typeof p !== "string" || p.length === 0) return null;
  const resolved = path.resolve(p);
  if (path.basename(resolved) !== "SKILL.md") return null;
  if (index) {
    const hit = index.get(resolved);
    if (hit) return hit;
  }
  return path.basename(path.dirname(resolved)) || null;
}

/** Duration in seconds → "42s" / "4m55s" / "1h2m" / "1.2d". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${(s / 86400).toFixed(1).replace(/\.0$/, "")}d`;
}

/** Milliseconds → UTC "YYYY-MM-DD" (null when missing/invalid). */
export function formatAddedDate(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** File birthtime ("introduced" date), falling back to mtime; null if unreadable. */
export function fileIntroducedDate(filePath: string): number | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const born = typeof st.birthtimeMs === "number" && st.birthtimeMs > 0 ? st.birthtimeMs : 0;
  const mtime = typeof st.mtimeMs === "number" && st.mtimeMs > 0 ? st.mtimeMs : 0;
  return born || mtime || null;
}

/**
 * Parse the tools list from the final system prompt's <tools> section text
 * (lines of the form `- name: description`). Returns the tool names in order;
 * dynamic/MCP tools are included because the section reflects `toolsAdded`.
 */
export function parseToolList(sectionText: string | undefined): string[] {
  if (!sectionText) return [];
  const names: string[] = [];
  for (const rawLine of sectionText.split("\n")) {
    const m = /^\s*[-*]\s+([A-Za-z0-9_.:-]+)\s*:\s/.exec(rawLine);
    if (m) names.push(m[1]);
  }
  return names;
}

const BUILTIN_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);

let piRootCache: string | null | undefined; // undefined = not resolved yet

const PI_PACKAGE_REL = path.join("node_modules", "@earendil-works", "pi-coding-agent");

/** Walk up from `startDir` looking for node_modules/@earendil-works/pi-coding-agent. */
function findPackageUp(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, PI_PACKAGE_REL);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate; // fs.statSync follows symlinks to the real install
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root reached
    dir = parent;
  }
}

/**
 * Root of the installed @earendil-works/pi-coding-agent package (or null).
 * The package root export is import-only (no "require" condition), so CJS
 * resolution can't be used. Try, in order: the extension's own node_modules
 * chain, the cwd chain, the running pi entry point, and the pi install's
 * release directories (latest first).
 */
export function piPackageRoot(): string | null {
  if (piRootCache !== undefined) return piRootCache;
  let root: string | null = null;
  try {
    root =
      findPackageUp(path.dirname(fileURLToPath(import.meta.url))) ??
      findPackageUp(process.cwd()) ??
      (process.argv[1] ? findPackageUp(path.dirname(process.argv[1])) : null);
    if (!root) {
      // last resort: ~/.pi/agent/install/releases/<ver>/node_modules/... (latest wins)
      const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
      const versions = fs
        .readdirSync(releases)
        .filter((v) => fs.statSync(path.join(releases, v)).isDirectory())
        .sort((a, b) => {
          const pa = a.split(".").map(Number);
          const pb = b.split(".").map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pb[i] ?? 0) - (pa[i] ?? 0);
            if (d !== 0) return d;
          }
          return a.localeCompare(b);
        })
        .reverse(); // latest release first
      for (const v of versions) {
        const candidate = path.join(releases, v, PI_PACKAGE_REL);
        if (fs.existsSync(path.join(candidate, "package.json"))) {
          root = candidate;
          break;
        }
      }
    }
  } catch {
    root = null;
  }
  piRootCache = root;
  return root;
}

/**
 * Introduced date of a tool: birthtime of its built-in dist file; for anything
 * else (dynamic/MCP tools) the pi package itself — i.e. "available since this
 * pi version was installed". Null when nothing can be resolved.
 */
export function toolIntroducedDate(name: string): number | null {
  const root = piPackageRoot();
  if (!root) return null;
  const file = BUILTIN_TOOLS.has(name)
    ? path.join(root, "dist", "core", "tools", `${name}.js`)
    : path.join(root, "package.json");
  return fileIntroducedDate(file);
}

/**
 * Work items from session entries: generated output tokens with timestamps.
 * Assistant messages + compaction + branch_summary entries only — `usage`
 * summary entries are rollups and would double-count. `usage.output` already
 * includes reasoning tokens, so nothing else is added.
 */
export function extractWorkItems(entries: readonly unknown[]): WorkItem[] {
  const out: WorkItem[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const entry = e as {
      type?: unknown;
      usage?: UsageLike;
      timestamp?: unknown;
      message?: { role?: unknown; usage?: UsageLike };
    };
    let u: UsageLike | undefined;
    if (entry.type === "message") {
      const m = entry.message;
      if (m && m.role === "assistant" && m.usage) u = m.usage;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      u = entry.usage;
    }
    if (!u) continue;
    const tokens = u.output ?? 0;
    if (tokens <= 0) continue;
    const ts = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(String(entry.timestamp ?? ""));
    if (!Number.isFinite(ts) || ts <= 0) continue;
    out.push({ tokens, timestamp: ts });
  }
  return out;
}

/** Σtokens / span(first→last) in seconds; null when the window can't define a rate. */
export function tokensPerSecond(items: readonly WorkItem[]): number | null {
  if (items.length < 2) return null;
  const spanSec = (items[items.length - 1].timestamp - items[0].timestamp) / 1000;
  if (!Number.isFinite(spanSec) || spanSec <= 0) return null;
  const tokens = items.reduce((s, i) => s + i.tokens, 0);
  if (tokens <= 0) return null;
  return tokens / spanSec;
}

function windowStats(items: readonly WorkItem[]): PerfWindow {
  const tps = tokensPerSecond(items);
  const span = items.length >= 2 ? (items[items.length - 1].timestamp - items[0].timestamp) / 1000 : 0;
  return {
    count: items.length,
    tokens: items.reduce((s, i) => s + i.tokens, 0),
    seconds: Number.isFinite(span) && span > 0 ? span : 0,
    tps,
  };
}

/** tokens/s for the whole session, last 10 and last 100 work items (turn order). */
export function perfStats(items: readonly WorkItem[]): PerformanceSection {
  return {
    session: windowStats(items),
    last10: windowStats(items.slice(-10)),
    last100: windowStats(items.slice(-100)),
  };
}

/** Resolve a self-report referrer (file URL or path) to an absolute path key. */
export function resolveUsageKey(referrer: unknown): string | null {
  if (typeof referrer !== "string" || referrer.length === 0) return null;
  try {
    if (referrer.startsWith("file://")) return fileURLToPath(referrer);
    return path.resolve(referrer);
  } catch {
    return null;
  }
}

/** Self-report an extension execution (called by extensions' own handlers). */
export function trackExtensionRun(referrer?: unknown): void {
  try {
    const key = resolveUsageKey(referrer);
    if (key) new UsageStore().recordExtension(key);
  } catch {
    // counters must never break the extension that reports them
  }
}

/** Record a skill use in the global store. */
/** Count one tool execution in the global store (never throws into the caller). */
export function trackToolUse(name: string): void {
  try {
    if (name) new UsageStore().recordTool(name);
  } catch {
    // never break the caller's flow over a stats counter
  }
}

export function trackSkillUse(name: string): void {
  try {
    if (name) new UsageStore().recordSkill(name);
  } catch {
    // never throw
  }
}

/** This file's own path, for self-reporting from the /stats handler. */
function selfExtensionKey(): string | null {
  try {
    return resolveUsageKey(import.meta.url);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ line building

const BAR_WIDTH = 30;

function pctOf(part: number, total: number | null): string {
  if (total == null || total <= 0) return "—";
  return `${Math.round((part / total) * 100)}%`;
}

/** Word-wrap `prefix + rest` at `width` columns with a hanging indent (plain text). */
function wrapped(prefix: string, rest: string, width: number): string[] {
  const max = Math.max(1, width - prefix.length);
  if (rest.length <= max) return [prefix + rest];
  const continuation = " ".repeat(prefix.length); // indent only, no repeated label
  const lines: string[] = [];
  let text = rest;
  let isFirst = true;
  while (text.length > max) {
    let cut = text.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max; // avoid orphan slivers
    lines.push((isFirst ? prefix : continuation) + text.slice(0, cut).trimEnd());
    text = text.slice(cut).trimStart();
    isFirst = false;
  }
  lines.push((isFirst ? prefix : continuation) + text);
  return lines;
}

export interface StatsColumns {
  /** LEFT group: live session state. */
  left: StatsLine[];
  /** RIGHT group: environment (loaded resources, tools, global usage). */
  right: StatsLine[];
  /** Full-width footer hint. */
  footer: StatsLine;
}

/**
 * Split the dashboard into two meaningful groups (v1.3):
 *   left  = "stats"       — live session state (header, context window, system
 *                           prompt sections, messages, tokens, performance)
 *   right = "environment" — what is loaded and how it is used (loaded resources,
 *                           tools, global usage)
 * `leftWidth` / `rightWidth` are the visible cell widths used for wrapping.
 * No information from the single-column layout was dropped — only regrouped.
 */
export function buildStatsColumns(d: StatsData, leftWidth: number, rightWidth: number): StatsColumns {
  const left: StatsLine[] = [];
  const right: StatsLine[] = [];
  const addL = (text: string, color: ColorRole = "default"): void => {
    left.push({ text, color });
  };
  const addR = (text: string, color: ColorRole = "default"): void => {
    right.push({ text, color });
  };

  // --------------------------------------------------- LEFT: session state
  addL("stats", "accent");
  addL(`model     ${d.model}${d.thinkingLevel ? ` · thinking ${d.thinkingLevel}` : ""}`);
  addL(`session   ${d.sessionName ? `${d.sessionName} (${d.sessionId})` : d.sessionId}`, "dim");
  addL(`cwd       ${d.cwd}`, "dim");
  addL(`status    ${d.status}${d.hasPending ? " · queued messages" : ""}`, d.status === "streaming" ? "warning" : "success");
  addL("", "default");

  addL("context window", "accent");
  if (d.contextTokens == null || d.contextWindow <= 0) {
    const known = d.contextTokens != null ? formatNumber(d.contextTokens) : "unknown";
    const window = d.contextWindow > 0 ? ` / ${formatNumber(d.contextWindow)}` : "";
    addL(`${bar(0, BAR_WIDTH)}  ${known}${window}`, "dim");
  } else {
    const pct = d.contextPercent ?? (d.contextTokens / d.contextWindow) * 100;
    const color: ColorRole = pct < 50 ? "success" : pct < 80 ? "warning" : "error";
    addL(`${bar(pct, BAR_WIDTH)}  ${formatNumber(d.contextTokens)} / ${formatNumber(d.contextWindow)} (${Math.round(pct)}%)`, color);
  }
  addL(`  system prompt  ~${formatNumber(d.systemPrompt.total)}  (${pctOf(d.systemPrompt.total, d.contextTokens)})`, "dim");
  addL(
    `  messages       ~${formatNumber(d.messages.tokens)}  (${pctOf(d.messages.tokens, d.contextTokens)})${
      d.messages.count > 0 ? `  (${d.messages.count} msgs)` : ""
    }`,
    "dim",
  );
  addL("", "default");

  addL("system prompt sections", "accent");
  if (d.systemPrompt.sections.length === 0) {
    addL("  (empty)", "dim");
  } else {
    for (const s of d.systemPrompt.sections) {
      const label = s.name === "skills" && d.skillsInPrompt > 0 ? `skills (${d.skillsInPrompt})` : s.name;
      addL(`  ${label.padEnd(18)}~${formatNumber(s.tokens)}  (${pctOf(s.tokens, d.systemPrompt.total)})`);
      if (s.name === "project_context" && d.contextFiles.length > 0) {
        for (const f of d.contextFiles) addL(`    ${f.path.padEnd(16)}~${formatNumber(f.tokens)}`, "dim");
      }
    }
  }
  addL("", "default");

  addL(`messages (${d.messages.count})`, "accent");
  if (d.messages.roles.length === 0) {
    addL("  (none)", "dim");
  } else {
    for (const r of d.messages.roles) {
      addL(`  ${r.role.padEnd(18)}${String(r.count).padStart(4)}  ~${formatNumber(r.tokens)}`, "dim");
    }
  }
  addL("", "default");

  addL("tokens (session)", "accent");
  addL(`  ${"in".padEnd(10)}${formatNumber(d.totals.input)}   ${"out".padEnd(6)}${formatNumber(d.totals.output)}`);
  addL(`  ↺read     ${formatNumber(d.totals.cacheRead)}   ↺write   ${formatNumber(d.totals.cacheWrite)}`, "dim");
  addL(`  cost      ${formatCost(d.totals.cost)}   ${d.totals.turns} turn${d.totals.turns === 1 ? "" : "s"}`);
  if (d.lastTurn) {
    const lt = d.lastTurn;
    let line = `  last turn   ↑${formatNumber(lt.input ?? 0)} ↓${formatNumber(lt.output ?? 0)}`;
    if (lt.cacheRead) line += ` ↺${formatNumber(lt.cacheRead)}`;
    if (lt.reasoning != null) line += ` · thinking ${formatNumber(lt.reasoning)}`;
    addL(line, "dim");
  }
  addL("", "default");

  addL("performance (output tokens/s)", "accent");
  const perfLine = (label: string, w: PerfWindow): void => {
    if (w.count === 0) {
      addL(`  ${label.padEnd(10)}—  (no data)`, "dim");
      return;
    }
    const tps = w.tps == null ? "—" : `${w.tps.toFixed(1)} tok/s`;
    addL(
      `  ${label.padEnd(10)}${tps.padEnd(13)}· ${formatNumber(w.tokens)} out / ${formatDuration(w.seconds)} (${w.count} turns)`,
      "dim",
    );
  };
  perfLine("session", d.performance.session);
  perfLine("last 10", d.performance.last10);
  perfLine("last 100", d.performance.last100);

  // --------------------------------------------------- RIGHT: environment
  addR("environment", "accent");
  addR("loaded resources", "accent");
  const resLine = (label: string, items: string[]): void => {
    const body = items.length > 0 ? items.join(", ") : "(none)";
    for (const line of wrapped(`  ${label.padEnd(12)}`, body, rightWidth)) addR(line, "dim");
  };
  resLine("context", d.resources.contextFiles.map((r) => r.name));
  resLine("skills", d.resources.skills.map((r) => r.name));
  resLine("prompts", d.resources.prompts.map((r) => `/${r.name}`));
  resLine("extensions", d.resources.extensions.map((r) => r.name));
  addR("", "default");

  addR(`tools (${d.resources.tools.length})`, "accent");
  if (d.resources.tools.length === 0) {
    addR("  (none)", "dim");
  } else {
    for (const line of wrapped("  ", d.resources.tools.join(", "), rightWidth)) addR(line, "dim");
  }
  addR("", "default");

  addR("usage (global · all sessions)", "accent");
  if (d.usage.skills.length === 0 && d.usage.extensions.length === 0 && d.usage.tools.length === 0) {
    addR("  (none)", "dim");
  } else {
    const usageBlock = (title: string, items: UsageItem[], singular: string, plural: string): void => {
      if (items.length === 0) return;
      addR(`  ${title}`, "dim");
      for (const it of items) {
        const unit = it.count === 1 ? singular : plural;
        addR(`    ${it.name.padEnd(14)}${String(it.count).padStart(4)} ${unit}  added ${it.added ?? "?"}`, "dim");
      }
    };
    usageBlock("skills", d.usage.skills, "use", "uses");
    usageBlock("extensions", d.usage.extensions, "run", "runs");
    usageBlock("tools", d.usage.tools, "run", "runs");
  }

  const footer: StatsLine = { text: "esc/q close · ↑↓/pgup/pgdn/wheel scroll · r refresh · updates live", color: "dim" };
  return { left, right, footer };
}

/**
 * Build the full dashboard content as plain styled lines (no ANSI, no borders —
 * the component adds those): `left │ right` rows + a full-width footer. `width`
 * is the total box width.
 */
export function buildStatsLines(d: StatsData, width: number): StatsLine[] {
  const cellL = Math.max(4, Math.floor((width - 7) / 2));
  const cellR = Math.max(4, width - 7 - cellL);
  const { left, right, footer } = buildStatsColumns(d, cellL, cellR);
  const rows = Math.max(left.length, right.length);
  const out: StatsLine[] = [];
  for (let i = 0; i < rows; i++) {
    const l = left[i];
    const r = right[i];
    out.push({
      text: `${padToWidth(l?.text ?? "", cellL)} │ ${padToWidth(r?.text ?? "", cellR)}`,
      color: l?.color ?? "default",
    });
  }
  out.push({ text: padToWidth(footer.text, cellL + 3 + cellR), color: footer.color });
  return out;
}

// ------------------------------------------------------- resource discovery
// (same rules as the core loader — mirrors ~/.pi/agent/extensions/reload-resources.ts)

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Absolute path with the home prefix replaced by `~`. */
function displayPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const home = os.homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(home + path.sep)) return `~${resolved.slice(home.length)}`;
  return resolved;
}

/** cwd-relative if under cwd, otherwise `~`-prefixed. */
function contextDisplayPath(absolutePath: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(absolutePath);
  if (resolved === resolvedCwd) return ".";
  if (resolved.startsWith(resolvedCwd + path.sep)) return path.relative(resolvedCwd, resolved);
  return displayPath(resolved);
}

function scopeGroup(scope: string | undefined, source: string | undefined): string {
  if (source === "cli" || scope === "temporary") return "path";
  if (scope === "user") return "user";
  if (scope === "project") return "project";
  return "path";
}

function extensionScope(resolvedPath: string, cwd: string, agentDir: string): string {
  const agentRoot = path.resolve(agentDir, "extensions");
  if (resolvedPath === agentRoot || resolvedPath.startsWith(agentRoot + path.sep)) return "user";
  const projectRoot = path.resolve(cwd, ".pi", "extensions");
  if (resolvedPath === projectRoot || resolvedPath.startsWith(projectRoot + path.sep)) return "project";
  return "path";
}

const isExtensionFile = (name: string): boolean => name.endsWith(".ts") || name.endsWith(".js");

/** package.json "pi.extensions" manifest, else index.ts/index.js. */
function resolveExtensionEntries(dir: string): string[] | null {
  const packageJsonPath = path.join(dir, "package.json");
  if (isFile(packageJsonPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: unknown } };
      const entries = manifest.pi?.extensions;
      if (Array.isArray(entries) && entries.length > 0) {
        const resolved: string[] = [];
        for (const entry of entries) {
          if (typeof entry === "string" && isFile(path.resolve(dir, entry))) resolved.push(path.resolve(dir, entry));
        }
        if (resolved.length > 0) return resolved;
      }
    } catch {
      // malformed manifest — fall through to index lookup
    }
  }
  const indexTs = path.join(dir, "index.ts");
  const indexJs = path.join(dir, "index.js");
  if (isFile(indexTs)) return [indexTs];
  if (isFile(indexJs)) return [indexJs];
  return null;
}

function discoverInDir(dir: string): string[] {
  if (!isDir(dir)) return [];
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
      found.push(full);
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const sub = resolveExtensionEntries(full);
      if (sub) found.push(...sub);
    }
  }
  return found;
}

/** Shortest unique path-suffix label per extension (drops trailing index.ts/index.js). */
function compactLabels(displayPaths: string[]): string[] {
  const segLists = displayPaths.map((p) => {
    const segs = p.replace(/\\/g, "/").split("/").filter((s) => s.length > 0 && s !== "~");
    const last = segs[segs.length - 1];
    if (segs.length > 1 && (last === "index.ts" || last === "index.js")) segs.pop();
    return segs;
  });
  return segLists.map((segs, i) => {
    if (segs.length === 0) return displayPaths[i];
    for (let n = 1; n <= segs.length; n++) {
      const candidate = segs.slice(-n).join("/");
      if (segLists.every((other, j) => (j === i ? true : other.slice(-n).join("/") !== candidate))) return candidate;
    }
    return segs.join("/");
  });
}

// ------------------------------------------------------------------- collect

export function collectLoadedResources(pi: ResourcesLike, cwd: string): LoadedResources {
  const agentDir = getAgentDir();

  const contextFiles: ResourceItem[] = loadProjectContextFiles({ cwd, agentDir }).map((f) => {
    const p = contextDisplayPath(f.path, cwd);
    return { name: p, path: p, scope: "" };
  });

  const { skills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
  const skillItems: ResourceItem[] = skills.map((s) => ({
    name: s.name,
    path: displayPath(s.filePath),
    scope: scopeGroup(s.sourceInfo?.scope, s.sourceInfo?.source),
    resolved: path.resolve(s.filePath),
  }));

  const promptItems: ResourceItem[] = pi
    .getCommands()
    .filter((c) => c.source === "prompt")
    .map((c) => ({
      name: c.name,
      path: displayPath(c.sourceInfo.path),
      scope: scopeGroup(c.sourceInfo.scope, c.sourceInfo.source),
    }));

  const allPaths: string[] = [];
  const seen = new Set<string>();
  const add = (paths: string[]): void => {
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved) && isFile(resolved)) {
        seen.add(resolved);
        allPaths.push(resolved);
      }
    }
  };
  add(discoverInDir(path.join(cwd, ".pi", "extensions")));
  add(discoverInDir(path.join(agentDir, "extensions")));
  const configured = pi.getSettings().extensions;
  if (Array.isArray(configured)) {
    for (const raw of configured) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
      if (isDir(resolved)) {
        const entries = resolveExtensionEntries(resolved);
        if (entries) add(entries);
        else add(discoverInDir(resolved));
        continue;
      }
      add([resolved]); // non-existent paths are skipped by add()
    }
  }
  const displayPaths = allPaths.map((p) => displayPath(p));
  const labels = compactLabels(displayPaths);
  const extensionItems: ResourceItem[] = allPaths.map((p, i) => ({
    name: labels[i],
    path: displayPaths[i],
    scope: extensionScope(p, cwd, agentDir),
    resolved: p,
  }));

  return { contextFiles, skills: skillItems, prompts: promptItems, extensions: extensionItems, tools: [] };
}

/** One immutable snapshot of everything the dashboard shows. */
export function collectStats(pi: ResourcesLike, ctx: StatsContextLike, opts: CollectStatsOptions = {}): StatsData {
  const entries = ctx.sessionManager.getEntries();
  const cu = ctx.getContextUsage();
  const lastTurn = getLastAssistantUsage(entries);
  const totals = sumSessionUsage(entries);

  const spOptions = ctx.getSystemPromptOptions();
  // Parse the FINAL prompt: structured sections are `<name>...</name>` blocks, the
  // untagged remainder is the preamble, and a forced custom prompt has no tags.
  const sectionTexts = parseSystemPromptSections(ctx.getSystemPrompt());
  const sections = sectionStats(sectionTexts);
  const spTotal = sections.reduce((s, x) => s + x.tokens, 0);
  const contextFiles = (spOptions.contextFiles ?? []).map((f) => ({
    path: contextDisplayPath(f.path, ctx.cwd),
    tokens: textTokens(f.content),
  }));
  const skillsInPrompt = spOptions.skills?.length ?? 0;

  let messages: StatsData["messages"] = { count: 0, tokens: 0, roles: [] };
  try {
    const contextMessages = buildSessionContext(entries).messages;
    const visible = contextMessages.filter((m) => m.role !== "system");
    const roles = roleBreakdown(visible);
    messages = {
      count: visible.length,
      tokens: roles.reduce((s, r) => s + r.tokens, 0),
      roles,
    };
  } catch {
    // projection failed — keep zeros, dashboard still shows the rest
  }

  const contextWindow = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextTokens = cu?.tokens ?? (lastTurn ? calculateContextTokens(lastTurn) : null);
  const contextPercent =
    cu?.percent ?? (contextTokens != null && contextWindow > 0 ? (contextTokens / contextWindow) * 100 : null);

  // loaded tools come from the prompt (dynamic/MCP tools included), not disk
  const resources: LoadedResources = {
    ...collectLoadedResources(pi, ctx.cwd),
    tools: parseToolList(sectionTexts["tools"]),
  };
  const usageData = new UsageStore(opts.usageStorePath).snapshot();
  const addedFor = (resolved: string | undefined): string | null =>
    resolved ? formatAddedDate(fileIntroducedDate(resolved)) : null;
  const usage: UsageSection = {
    skills: resources.skills
      .map((s) => ({ name: s.name, count: usageData.skills[s.name]?.count ?? 0, added: addedFor(s.resolved) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    extensions: resources.extensions
      .map((e) => ({ name: e.name, count: usageData.extensions[e.resolved ?? e.path]?.count ?? 0, added: addedFor(e.resolved) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    tools: resources.tools
      .map((t) => ({ name: t, count: usageData.tools[t]?.count ?? 0, added: formatAddedDate(toolIntroducedDate(t)) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
  const performance = perfStats(extractWorkItems(entries));

  return {
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
    thinkingLevel: ctx.thinkingLevel,
    sessionName: stripTerminalSequences(ctx.sessionManager.getSessionName() ?? "") || undefined,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    status: ctx.isIdle() ? "idle" : "streaming",
    hasPending: ctx.hasPendingMessages(),
    contextTokens,
    contextWindow,
    contextPercent,
    systemPrompt: { sections, total: spTotal },
    contextFiles,
    skillsInPrompt,
    messages,
    totals,
    lastTurn: lastTurn ?? null,
    resources,
    usage,
    performance,
  };
}

// ------------------------------------------------------------- dashboard UI

/** ANSI-aware right-pad to `width` visible columns. */
function padToWidth(text: string, width: number): string {
  const vw = visibleWidth(text);
  if (vw >= width) return text;
  return text + " ".repeat(width - vw);
}

const ROLE_THEME_TOKEN: Record<Exclude<ColorRole, "default">, ThemeColor> = {
  dim: "dim",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
};

export class StatsDashboard implements Component {
  private theme: Theme;
  private tui: TUI;
  private keybindings: KeybindingsManager;
  private data: StatsData;
  private done: () => void;
  private onRefresh: (() => void) | undefined;
  private handle: OverlayHandle | undefined;
  private scrollTop = 0;
  private cachedHeight = 0;

  constructor(
    theme: Theme,
    tui: TUI,
    keybindings: KeybindingsManager,
    data: StatsData,
    done: () => void,
    onRefresh?: () => void,
  ) {
    this.theme = theme;
    this.tui = tui;
    this.keybindings = keybindings;
    this.data = data;
    this.done = done;
    this.onRefresh = onRefresh;
  }

  /** Wire the overlay handle (set after the overlay is shown). */
  setHandle(handle: OverlayHandle): void {
    this.handle = handle;
  }

  /** Replace the snapshot and repaint (called by live updates / `r`). */
  setData(data: StatsData): void {
    this.data = data;
    this.invalidate();
    this.tui.requestRender();
  }

  invalidate(): void {
    // lines are rebuilt on every render — nothing cached per-line
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
      this.done();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      this.scrollBy(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.scrollBy(1);
      return;
    }
    if (kb.matches(data, "tui.select.pageUp")) {
      this.scrollBy(-this.pageSize());
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.scrollBy(this.pageSize());
      return;
    }
    // Raw SGR mouse sequences can pass through handleInput when the terminal
    // forwards them (regular mode has no parsed mouse events): 64 = wheel up,
    // 65 = wheel down. Only "M" (press) carries wheel motion.
    const sgr = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
    if (sgr) {
      const button = Number(sgr[1]);
      if (button === 64) this.scrollBy(-1);
      else if (button === 65) this.scrollBy(1);
      return;
    }
    if (data === "r" || data === "R") {
      this.onRefresh?.();
    }
  }

  /** Mouse wheel scrolling (fullscreen/alt mode parses mouse events; regular mode uses the SGR passthrough in handleInput). */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    return { handled: true, render: this.scrollBy(event.wheelDelta) };
  }

  dispose(): void {
    // nothing to release (subscriptions are owned by the command handler)
  }

  /**
   * Content rows the box can hold. The overlay is capped at `maxHeight: "88%"`
   * (= floor(rows * 0.88) total lines, exactly what parseSizeValue computes),
   * minus the two border rows. Must NOT be derived from the overlay bounds:
   * `compositeOverlays` resets `entry.bounds` to undefined at the start of every
   * render pass, so bounds are always stale/undefined inside `render()` — using
   * them makes every frame render full content (bottom border sliced off) and
   * clamp `scrollTop` back to 0 (scrolling appears broken).
   */
  private contentHeight(): number {
    const rows = this.tui.terminal?.rows ?? 24;
    return Math.max(4, Math.floor((rows * 88) / 100) - 2);
  }

  private pageSize(): number {
    return this.contentHeight();
  }

  /** Scroll by delta rows; returns true when the visible window changed. */
  private scrollBy(delta: number): boolean {
    const viewH = this.contentHeight();
    if (viewH <= 0 || this.cachedHeight === 0) return false;
    const next = clampScroll(this.scrollTop, delta, this.cachedHeight, viewH);
    if (next === this.scrollTop) return false;
    this.scrollTop = next;
    this.invalidate();
    this.tui.requestRender();
    return true;
  }

  private styleLine(line: StatsLine): string {
    return line.color === "default" ? line.text : this.theme.fg(ROLE_THEME_TOKEN[line.color], line.text);
  }

  /** ANSI-safe cell: truncate → theme-color → pad to exactly `cellWidth` visible columns. */
  private styleCell(color: ColorRole, text: string, cellWidth: number): string {
    return padToWidth(this.styleLine({ text: truncateToWidth(text, cellWidth), color }), cellWidth);
  }

  render(width: number): string[] {
    // v1.3 two-column layout: `│ left │ right │` rows. Geometry keeps the middle
    // divider aligned with the ┬/┴ in the borders: cellL + 3 (" │ ") + cellR = width - 7.
    const cellL = Math.max(4, Math.floor((width - 7) / 2));
    const cellR = Math.max(4, width - 7 - cellL);
    const { left, right, footer } = buildStatsColumns(this.data, cellL, cellR);
    const rows = Math.max(left.length, right.length);
    const composed: string[] = [];
    for (let i = 0; i < rows; i++) {
      const l = left[i];
      const r = right[i];
      composed.push(
        `${this.styleCell(l?.color ?? "default", l?.text ?? "", cellL)} │ ${this.styleCell(r?.color ?? "default", r?.text ?? "", cellR)}`,
      );
    }
    composed.push(this.styleCell(footer.color, footer.text, cellL + 3 + cellR));
    this.cachedHeight = composed.length;

    // Stable viewport (see contentHeight): output is exactly viewH + 2 border
    // lines, never more than the overlay maxHeight — the bottom border is
    // always drawn and scroll position survives re-renders.
    const viewH = this.contentHeight();
    this.scrollTop = Math.min(this.scrollTop, Math.max(0, composed.length - viewH));
    const visible = composed.slice(this.scrollTop, this.scrollTop + viewH);

    const dividerL = "─".repeat(cellL + 2);
    const dividerR = "─".repeat(cellR + 2);
    const out: string[] = [];
    out.push(this.styleLine({ text: `╭${dividerL}┬${dividerR}╮`, color: "dim" }));
    for (const line of visible) {
      out.push(`│ ${line} │`);
    }
    out.push(this.styleLine({ text: `╰${dividerL}┴${dividerR}╯`, color: "dim" }));
    return out;
  }
}

// ------------------------------------------------------------------- command

const REFRESH_THROTTLE_MS = 250;

export default function (pi: ExtensionAPI): void {
  // ---- global usage tracking (process-wide, all sessions — not just while open) ----
  // Skills: explicit "/skill:name" input + the agent reading a SKILL.md via `read`.
  // Extension commands are invisible here (they run before the input event), so
  // extensions self-report via trackExtensionRun(import.meta.url).
  let skillIndex: Map<string, string> | undefined;
  const skillIndexNow = (): Map<string, string> => {
    if (!skillIndex) {
      skillIndex = new Map<string, string>();
      try {
        const { skills } = loadSkills({ cwd: process.cwd(), agentDir: getAgentDir(), skillPaths: [], includeDefaults: true });
        for (const s of skills) skillIndex.set(path.resolve(s.filePath), s.name);
      } catch {
        // index stays empty → skillUseFromRead falls back to the directory name
      }
    }
    return skillIndex;
  };
  const invalidateSkillIndex = (): void => {
    skillIndex = undefined;
  };
  pi.on("input", (event) => {
    const name = attributeSkillInput(event.text);
    if (name) trackSkillUse(name);
  });
  pi.on("tool_execution_start", (event) => {
    trackToolUse(event.toolName);
    const name = skillUseFromRead(event.toolName, event.args, skillIndexNow());
    if (name) trackSkillUse(name);
  });
  pi.on("session_start", invalidateSkillIndex);
  pi.on("resources_discover", invalidateSkillIndex);

  pi.registerCommand("stats", {
    description: "Open the live session stats dashboard (overlay; works while the agent is running)",
    handler: async (_args, ctx) => {
      trackExtensionRun(selfExtensionKey());
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/stats needs the interactive TUI", "warning");
        return;
      }

      let data: StatsData;
      try {
        data = collectStats(pi, ctx);
      } catch (err) {
        ctx.ui.notify(`stats: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      let comp: StatsDashboard | undefined;
      let lastRefreshAt = 0;
      const refresh = (): void => {
        const now = Date.now();
        if (now - lastRefreshAt < REFRESH_THROTTLE_MS) return;
        lastRefreshAt = now;
        try {
          comp?.setData(collectStats(pi, ctx));
        } catch {
          // keep the last good frame
        }
      };

      // Live updates while the overlay is open (unsubscribed in finally).
      const subs: (() => void)[] = [
        pi.on("message_update", refresh),
        pi.on("turn_start", refresh),
        pi.on("turn_end", refresh),
        pi.on("agent_start", refresh),
        pi.on("agent_end", refresh),
        pi.on("session_compact", refresh),
        pi.on("session_info_changed", refresh),
      ];

      try {
        await ctx.ui.custom<undefined>(
          (tui, theme, keybindings, done) => {
            comp = new StatsDashboard(theme, tui, keybindings, data, () => done(undefined), refresh);
            return comp;
          },
          {
            overlay: true,
            // v1.3: 92% width so the two columns have comfortable room
            overlayOptions: { width: "92%", maxHeight: "88%", anchor: "center", margin: 1 },
            onHandle: (handle) => {
              comp?.setHandle(handle);
            },
          },
        );
      } finally {
        for (const unsub of subs) {
          try {
            unsub();
          } catch {
            // non-fatal
          }
        }
        comp = undefined;
      }
    },
  });
}
