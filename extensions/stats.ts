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
 *   - changes (v1.4): added/deleted LINES (code + text combined) in the session
 *     cwd since session start — git numstat vs. a session-start HEAD baseline
 *     (commits during the session still count) + untracked files; one cached
 *     git spawn per 2 s (see collectGitChanges)
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
import { exec } from "node:child_process";
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
  /** v1.4: git changes for the session cwd (undefined = still loading). */
  git?: GitChangesResult;
  /** v1.5: MTP acceptance rate from LM Studio (absent/null = no data / not probed). */
  mtp?: MtpStats | null;
  /** v1.5: performance-impact rating (1 cheap … 5 costly) per extension/tool. */
  ratings?: RatingsSection;
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
  /** v1.5: the single most recent turn (rate over its own span). */
  last?: PerfWindow;
}

export interface CollectStatsOptions {
  /** Override the global usage store file (tests). */
  usageStorePath?: string;
  /** Override the global perf store file (tests). */
  perfStorePath?: string;
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

// ------------------------------------------- v1.5: MTP acceptance + perf rating

/** Global tool-duration store location (PI_STATS_PERF_FILE overrides for tests). */
export function perfStorePath(): string {
  const env = process.env.PI_STATS_PERF_FILE;
  if (env && env.length > 0) return path.resolve(env);
  return path.join(getAgentDir(), "perf-stats.json");
}

/** One measured aggregate per tool in the perf store. */
export interface PerfRecord {
  calls: number;
  totalMs: number;
  maxMs: number;
  firstSeen: string;
  lastUsed: string;
}

/** Shape of the global tool-perf store file (~/.pi/agent/perf-stats.json). */
export interface PerfData {
  version: number;
  tools: Record<string, PerfRecord>;
}

function normalizePerfData(parsed: unknown): PerfData {
  const p = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const tools: Record<string, PerfRecord> = {};
  if (p.tools && typeof p.tools === "object" && !Array.isArray(p.tools)) {
    for (const [k, raw] of Object.entries(p.tools as Record<string, unknown>)) {
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const num = (v: unknown): number =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
      tools[k] = {
        calls: Math.floor(num(r.calls)),
        totalMs: num(r.totalMs),
        maxMs: num(r.maxMs),
        firstSeen: typeof r.firstSeen === "string" ? r.firstSeen : new Date(0).toISOString(),
        lastUsed: typeof r.lastUsed === "string" ? r.lastUsed : new Date(0).toISOString(),
      };
    }
  }
  return { version: 1, tools };
}

/**
 * Global (across sessions/processes) tool-duration measurements feeding the
 * perf rating. Same read-modify-write + corrupt-reset contract as UsageStore.
 * Invalid durations (missing/≤0/non-finite) are NOT recorded.
 */
export class PerfStore {
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ? path.resolve(filePath) : perfStorePath();
  }

  load(): PerfData {
    try {
      return normalizePerfData(JSON.parse(fs.readFileSync(this.filePath, "utf-8")));
    } catch {
      return { version: 1, tools: {} };
    }
  }

  snapshot(): PerfData {
    return this.load();
  }

  /** Average ms/call for a tool (null when there is no data). */
  avgMs(tool: string): number | null {
    const rec = this.load().tools[tool];
    return rec && rec.calls > 0 ? rec.totalMs / rec.calls : null;
  }

  record(tool: string, ms: number, now: number = Date.now()): PerfData {
    if (!tool || !Number.isFinite(ms) || ms <= 0) return this.load();
    const data = this.load();
    const prev = data.tools[tool];
    const iso = new Date(now).toISOString();
    data.tools[tool] = prev
      ? {
          calls: prev.calls + 1,
          totalMs: prev.totalMs + ms,
          maxMs: Math.max(prev.maxMs, ms),
          firstSeen: prev.firstSeen,
          lastUsed: iso,
        }
      : { calls: 1, totalMs: ms, maxMs: ms, firstSeen: iso, lastUsed: iso };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch {
      // never break the caller's flow over a stats counter
    }
    return data;
  }
}

/** LM Studio speculative-decoding (MTP) counters from a completion response. */
export interface MtpStats {
  total: number;
  accepted: number;
  rejected: number;
  ignored: number;
  rate: number;
}

function asFinite(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse the `stats` object LM Studio attaches to completion responses
 * ({total,accepted,rejected,ignored}_draft_tokens_count). Returns null when the
 * server reported no draft traffic (empty stats / total 0 / missing) — the
 * dashboard then shows no MTP row at all.
 */
export function parseMtpStats(body: unknown): MtpStats | null {
  const s = (body as { stats?: unknown } | null | undefined)?.stats;
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  const total = Math.floor(asFinite(o.total_draft_tokens_count));
  if (total <= 0) return null;
  const accepted = Math.min(total, Math.floor(asFinite(o.accepted_draft_tokens_count)));
  return {
    total,
    accepted,
    rejected: Math.floor(asFinite(o.rejected_draft_tokens_count)),
    ignored: Math.floor(asFinite(o.ignored_draft_tokens_count)),
    rate: accepted / total,
  };
}

/** In-process MTP probe cache (60 s) so repeated probes/refreshes stay cheap. */
let mtpProbeCache: { model: string; at: number; value: MtpStats | null } | null = null;

/** Test hook: drop the MTP probe cache. */
export function mtpProbeCacheForTests(): void {
  mtpProbeCache = null;
}

/**
 * Probe LM Studio for the MTP acceptance rate: one tiny chat completion
 * (max_tokens 32) whose response carries the draft-token counters. Callers gate
 * on provider === "lmstudio"; never throws (null = no data → no dashboard row).
 */
export async function probeMtpAcceptance(
  modelId: string,
  baseUrl?: string,
  timeoutMs = 5000,
): Promise<MtpStats | null> {
  const base = (baseUrl ?? process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234").replace(/\/+$/, "");
  const now = Date.now();
  if (mtpProbeCache && mtpProbeCache.model === modelId && now - mtpProbeCache.at < 60_000) {
    return mtpProbeCache.value;
  }
  let value: MtpStats | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 32,
        temperature: 0,
        stream: false,
      }),
    });
    clearTimeout(timer);
    if (res.ok) value = parseMtpStats(await res.json());
  } catch {
    value = null; // server down / timeout / bad response → no MTP row
  }
  mtpProbeCache = { model: modelId, at: Date.now(), value };
  return value;
}

// ---------------------------------------- perf rating (1 cheap … 5 costly)

/** Band edges: value ≥ edge ⇒ one band up (score 1..5). See PERFORMANCE-RATING.md. */
export const RATING_BANDS = {
  durationMs: [50, 200, 1_000, 10_000],
  calls: [10, 100, 1_000, 10_000],
  bytes: [2_048, 8_192, 32_768, 102_400],
  subscriptions: [2, 4, 6, 10],
} as const;

/** Weights of the composite rating (sum = 1). */
export const RATING_WEIGHTS = { duration: 0.5, frequency: 0.3, static: 0.2 } as const;

function bandScore(bands: readonly number[], v: number): number {
  let s = 1;
  for (const b of bands) if (v >= b) s++;
  return s;
}

/** Static (source-level) metrics — pure over the source text. */
export function staticSourceMetrics(source: string): { bytes: number; subs: number; tui: boolean } {
  const subs = (source.match(/pi\.on\(/g) ?? []).length;
  const tui = /ui\.custom\(|showOverlay\(|registerComponent\(/.test(source);
  return { bytes: Buffer.byteLength(source, "utf-8"), subs, tui };
}

const staticMetricsCache = new Map<string, { at: number; value: { bytes: number; subs: number; tui: boolean } | null }>();

/** Read an extension file and compute static metrics (30 s TTL cache). null = unreadable. */
export function extensionStaticMetrics(filePath: string): { bytes: number; subs: number; tui: boolean } | null {
  const hit = staticMetricsCache.get(filePath);
  const now = Date.now();
  if (hit && now - hit.at < 30_000) return hit.value;
  let value: { bytes: number; subs: number; tui: boolean } | null = null;
  try {
    value = staticSourceMetrics(fs.readFileSync(filePath, "utf-8"));
  } catch {
    value = null;
  }
  staticMetricsCache.set(filePath, { at: now, value });
  return value;
}

/** Implementation size of a tool in bytes (built-ins: dist/core/tools/<name>.js; else null). */
export function toolImplBytes(name: string): number | null {
  const root = piPackageRoot();
  if (!root) return null;
  try {
    return fs.statSync(path.join(root, "dist/core/tools", `${name}.js`)).size;
  } catch {
    return null;
  }
}

export interface RatingInput {
  kind: "tool" | "extension";
  name: string;
  /** Global runs (usage store). */
  calls: number;
  /** Measured average ms/call (perf store); null = no data yet. */
  avgMs: number | null;
  /** Source/implementation size in bytes; null = unknown (neutral). */
  bytes: number | null;
  /** Extensions: pi.on() subscription count (per-event overhead). */
  subscriptions?: number;
  /** Extensions: renders per TUI frame (ui.custom/showOverlay/registerComponent). */
  tuiPerFrame?: boolean;
}

export interface ItemRating {
  name: string;
  kind: "tool" | "extension";
  /** Composite 1 (cheap) … 5 (costly). */
  rating: number;
  duration: number;
  frequency: number;
  static: number;
  avgMs: number | null;
  calls: number;
}

/** Composite performance-impact rating; bands/weights in RATING_BANDS / RATING_WEIGHTS. */
export function rateItem(i: RatingInput): ItemRating {
  const duration = i.avgMs == null ? 1 : bandScore(RATING_BANDS.durationMs, i.avgMs);
  const frequency = bandScore(RATING_BANDS.calls, Math.max(0, i.calls));
  let stat: number;
  if (i.kind === "extension") {
    stat = Math.max(
      i.bytes == null ? 3 : bandScore(RATING_BANDS.bytes, i.bytes),
      bandScore(RATING_BANDS.subscriptions, i.subscriptions ?? 0),
    );
    if (i.tuiPerFrame) stat = Math.min(5, stat + 1);
  } else {
    stat = i.bytes == null ? 3 : bandScore(RATING_BANDS.bytes, i.bytes);
  }
  const overall = Math.round(
    RATING_WEIGHTS.duration * duration + RATING_WEIGHTS.frequency * frequency + RATING_WEIGHTS.static * stat,
  );
  return {
    name: i.name,
    kind: i.kind,
    rating: Math.min(5, Math.max(1, overall)),
    duration,
    frequency,
    static: stat,
    avgMs: i.avgMs,
    calls: i.calls,
  };
}

export interface RatedItem {
  name: string;
  rating: number;
  avgMs: number | null;
  calls: number;
}

export interface RatingsSection {
  extensions: RatedItem[];
  tools: RatedItem[];
}

/** Milliseconds → "52ms" / "2.5s" / "1m0s" / … (delegates to formatDuration ≥ 1 min). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  return formatDuration(ms / 1000);
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
/**
 * Rate of the single most recent work item (the "last turn"): its output tokens
 * over the wall time since the previous item. Null rate when there is no
 * previous item or the span is zero.
 */
export function lastTurnWindow(items: readonly WorkItem[]): PerfWindow {
  const n = items.length;
  if (n === 0) return { count: 0, tokens: 0, seconds: 0, tps: null };
  const last = items[n - 1];
  const spanSec = n >= 2 ? (last.timestamp - items[n - 2].timestamp) / 1000 : 0;
  const ok = n >= 2 && Number.isFinite(spanSec) && spanSec > 0 && last.tokens > 0;
  return {
    count: 1,
    tokens: last.tokens,
    seconds: ok ? spanSec : 0,
    tps: ok ? last.tokens / spanSec : null,
  };
}

export function perfStats(items: readonly WorkItem[]): PerformanceSection {
  return {
    session: windowStats(items),
    last10: windowStats(items.slice(-10)),
    last100: windowStats(items.slice(-100)),
    last: lastTurnWindow(items),
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

// ------------------------------------------------------------ git changes (v1.4)

/** Per-file line change (from `git diff --numstat`). */
export interface GitChangeFile {
  path: string;
  added: number;
  deleted: number;
}

/**
 * Aggregated changes for one cwd: tracked diff (baseline→working tree, so commits
 * made during the session still count) plus untracked files (their lines = added).
 * Code and text are combined — every file counts, lines = newline counts.
 */
export interface GitChanges {
  added: number;
  deleted: number;
  files: number;
  untracked: { files: number; added: number };
  /** All changed files, sorted by (added+deleted) desc. */
  top: GitChangeFile[];
}

/**
 * Result of a git changes probe. An ABSENT `StatsData.git` (undefined) means
 * "still loading" — the dashboard omits the section until the probe answers.
 */
export type GitChangesResult =
  | { kind: "changes"; changes: GitChanges }
  | { kind: "not-repo" }
  | { kind: "unavailable"; reason: string };

const GIT_TTL_MS = 2_000;
const GIT_TIMEOUT_MS = 5_000;

interface GitCacheEntry {
  at: number;
  value: GitChangesResult;
}

const gitCache = new Map<string, GitCacheEntry>();
const gitInFlightMap = new Map<string, Promise<GitChangesResult>>();

/** Single-quoted shell escape (cwd/ref values are internal, but stay safe). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Parse `git diff --numstat <ref>` output. `-` counts = binary file (0 lines). */
export function parseNumstat(output: string): Omit<GitChanges, "untracked"> {
  let added = 0;
  let deleted = 0;
  let files = 0;
  const top: GitChangeFile[] = [];
  for (const line of output.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    files++;
    const a = m[1] === "-" ? 0 : Number(m[1]);
    const del = m[2] === "-" ? 0 : Number(m[2]);
    added += a;
    deleted += del;
    top.push({ path: m[3], added: a, deleted: del });
  }
  top.sort(
    (x, y) =>
      y.added + y.deleted - (x.added + x.deleted) ||
      y.added - x.added ||
      x.path.localeCompare(y.path),
  );
  return { added, deleted, files, top };
}

/** Parse `wc -l` output for untracked files; skips `total` lines (xargs may run wc several times). */
export function parseUntrackedWc(output: string): { files: number; added: number } {
  let files = 0;
  let added = 0;
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m || m[2] === "total") continue;
    files++;
    added += Number(m[1]);
  }
  return { files, added };
}

/**
 * Probe git changes for `cwd` (the MOST EFFICIENT way: ONE shell spawn that runs
 * both invocations, `--no-optional-locks` so it never blocks other git processes,
 * 5 s timeout, 2 s TTL cache per cwd+baseline with in-flight dedupe — live
 * refreshes never re-spawn inside the window). `baseline` = HEAD at session start
 * (null → falls back to `HEAD` = uncommitted changes only).
 */
export function collectGitChanges(cwd: string, baseline?: string | null): Promise<GitChangesResult> {
  const key = `${cwd}\0${baseline ?? ""}`;
  const cached = gitCache.get(key);
  if (cached && Date.now() - cached.at < GIT_TTL_MS) return Promise.resolve(cached.value);
  const inflight = gitInFlightMap.get(key);
  if (inflight) return inflight;
  const ref = baseline ?? "HEAD";
  const script =
    `git --no-optional-locks -C ${shellQuote(cwd)} diff --numstat ${shellQuote(ref)} 2>&1; ` +
    `printf '\n--UNTRACKED--\n'; ` +
    `git --no-optional-locks -C ${shellQuote(cwd)} ls-files --others --exclude-standard -z 2>/dev/null | ` +
    `xargs -0 -r wc -l -- 2>/dev/null`;
  const p = new Promise<GitChangesResult>((resolve) => {
    exec(script, { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, cwd }, (error, stdout, stderr) => {
      const out = stdout ?? "";
      let result: GitChangesResult;
      if (error && !out) {
        result = /not a git repository|ENOENT/i.test(stderr || error.message)
          ? { kind: "not-repo" }
          : { kind: "unavailable", reason: String(error.message || stderr || "git failed").slice(0, 80) };
      } else {
        const idx = out.indexOf("--UNTRACKED--");
        const numstatPart = idx >= 0 ? out.slice(0, idx) : out;
        const wcPart = idx >= 0 ? out.slice(idx + "--UNTRACKED--".length) : "";
        // git >= 2.31-ish prints `warning: Not a git repository` (plus a usage dump,
        // exit 0) outside a repo; older versions print `fatal: not a git repository`
        if (/not a git repository/i.test(numstatPart)) {
          result = { kind: "not-repo" };
        } else {
          // fresh repo (no HEAD yet) or stale baseline → no tracked lines, untracked still counted
          const tracked = /fatal: (ambiguous argument|bad revision)/i.test(numstatPart)
            ? { added: 0, deleted: 0, files: 0, top: [] as GitChangeFile[] }
            : parseNumstat(numstatPart);
          result = { kind: "changes", changes: { ...tracked, untracked: parseUntrackedWc(wcPart) } };
        }
      }
      gitCache.set(key, { at: Date.now(), value: result });
      gitInFlightMap.delete(key);
      resolve(result);
    });
  });
  gitInFlightMap.set(key, p);
  return p;
}

let gitBaseline: { cwd: string; head: string | null } | undefined;

/**
 * Capture HEAD for `cwd` as the session-start baseline (in-memory only — zero
 * persistence, display-only rule intact). Called on `resources_discover` (fires
 * with cwd at startup/reload, i.e. session start). Failure keeps head=null →
 * `collectGitChanges` falls back to plain `HEAD`.
 */
export function captureGitBaseline(cwd: string): void {
  gitBaseline = { cwd, head: null };
  exec(`git --no-optional-locks -C ${shellQuote(cwd)} rev-parse --verify HEAD`, { timeout: 3_000 }, (error, stdout) => {
    if (error) return;
    if (gitBaseline?.cwd !== cwd) return; // a newer session overwrote us
    gitBaseline.head = stdout.trim() || null;
  });
}

/** Current git baseline (handler + tests). */
export function currentGitBaseline(): { cwd: string; head: string | null } | undefined {
  return gitBaseline;
}

/** Test-only: drop the TTL cache + in-flight entries (lets tests re-probe a changed repo). */
export function resetGitProbeCacheForTests(): void {
  gitCache.clear();
  gitInFlightMap.clear();
}

/**
 * Split the dashboard into two meaningful groups (v1.3):
 *   left  = "stats"       — live session state (header, context window, system
 *                           prompt sections, messages, tokens, changes, performance)
 *   right = "environment" — what is loaded and how it is used (loaded resources,
 *                           tools, global usage)
 * `leftWidth` / `rightWidth` are the visible cell widths used for wrapping.
 * No information from the single-column layout was dropped — only regrouped.
 */
/**
 * First-column width for a table of rows: every label is padded so the second
 * column starts at the SAME index on every row (aligned columns, no matter how
 * long a name gets). `min` keeps the compact look while all labels are short;
 * the longest label gets exactly `gap` trailing spaces.
 */
export function columnWidth(labels: string[], min = 14, gap = 2): number {
  let width = min;
  for (const l of labels) width = Math.max(width, l.length + gap);
  return width;
}

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
    const sectionLabel = (s: SectionStat): string =>
      s.name === "skills" && d.skillsInPrompt > 0 ? `skills (${d.skillsInPrompt})` : s.name;
    const secW = columnWidth(d.systemPrompt.sections.map(sectionLabel), 18);
    const fileW = columnWidth(d.contextFiles.map((f) => f.path), 16);
    for (const s of d.systemPrompt.sections) {
      addL(`  ${sectionLabel(s).padEnd(secW)}~${formatNumber(s.tokens)}  (${pctOf(s.tokens, d.systemPrompt.total)})`);
      if (s.name === "project_context" && d.contextFiles.length > 0) {
        for (const f of d.contextFiles) addL(`    ${f.path.padEnd(fileW)}~${formatNumber(f.tokens)}`, "dim");
      }
    }
  }
  addL("", "default");

  addL(`messages (${d.messages.count})`, "accent");
  if (d.messages.roles.length === 0) {
    addL("  (none)", "dim");
  } else {
    const roleW = columnWidth(d.messages.roles.map((r) => r.role), 18);
    for (const r of d.messages.roles) {
      addL(`  ${r.role.padEnd(roleW)}${String(r.count).padStart(4)}  ~${formatNumber(r.tokens)}`, "dim");
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

  // ------------------------------------------------- changes (git, this session)
  addL("changes (this session, git)", "accent");
  const git = d.git;
  if (git === undefined) {
    addL("  …", "dim"); // probe still running — section fills in on the next frame
  } else if (git.kind === "not-repo") {
    addL("  (not a git repo)", "dim");
  } else if (git.kind === "unavailable") {
    addL("  (git unavailable)", "dim");
  } else {
    const c = git.changes;
    addL(`  +${formatNumber(c.added)}  -${formatNumber(c.deleted)}  · ${c.files} file${c.files === 1 ? "" : "s"}`);
    if (c.untracked.files > 0) {
      addL(`  +${formatNumber(c.untracked.added)} untracked (${c.untracked.files} file${c.untracked.files === 1 ? "" : "s"})`, "dim");
    }
    if (c.top.length > 0) {
      const top = c.top
        .slice(0, 2)
        .map((f) => `${f.path} +${formatNumber(f.added)}${f.deleted > 0 ? ` -${formatNumber(f.deleted)}` : ""}`)
        .join(" · ");
      addL(`  top: ${top}`, "dim");
    }
  }
  addL("", "default");

  addL("performance (output tokens/s)", "accent");
  const perfLabels = ["session", "last 10", "last 100"];
  if (d.performance.last) perfLabels.push("last turn");
  if (d.mtp) perfLabels.push("mtp (lm studio)");
  const perfW = columnWidth(perfLabels, 10);
  const perfLine = (label: string, w: PerfWindow, suffix = `${w.count} turns`): void => {
    if (w.count === 0) {
      addL(`  ${label.padEnd(perfW)}—  (no data)`, "dim");
      return;
    }
    const tps = w.tps == null ? "—" : `${w.tps.toFixed(1)} tok/s`;
    addL(
      `  ${label.padEnd(perfW)}${tps.padEnd(13)}· ${formatNumber(w.tokens)} out / ${formatDuration(w.seconds)} (${suffix})`,
      "dim",
    );
  };
  perfLine("session", d.performance.session);
  perfLine("last 10", d.performance.last10);
  perfLine("last 100", d.performance.last100);
  if (d.performance.last) perfLine("last turn", d.performance.last, "last");
  if (d.mtp) {
    const m = d.mtp;
    addL(
      `  ${"mtp (lm studio)".padEnd(perfW)}${"—".padEnd(13)}· ${m.accepted}/${m.total} drafts (${Math.round(m.rate * 100)}% accepted)`,
      "dim",
    );
  }

  // --------------------------------------------------- RIGHT: environment
  addR("environment", "accent");
  addR("loaded resources", "accent");
  const resW = columnWidth(["context", "skills", "prompts", "extensions"], 12);
  const resLine = (label: string, items: string[]): void => {
    const body = items.length > 0 ? items.join(", ") : "(none)";
    for (const line of wrapped(`  ${label.padEnd(resW)}`, body, rightWidth)) addR(line, "dim");
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
    const usageW = columnWidth(
      [...d.usage.skills, ...d.usage.extensions, ...d.usage.tools].map((it) => it.name),
      14,
    );
    const countW = Math.max(
      4,
      ...[...d.usage.skills, ...d.usage.extensions, ...d.usage.tools].map((it) => String(it.count).length),
    );
    const usageBlock = (title: string, items: UsageItem[], singular: string, plural: string): void => {
      if (items.length === 0) return;
      addR(`  ${title}`, "dim");
      for (const it of items) {
        const unit = it.count === 1 ? singular : plural;
        addR(
          `    ${it.name.padEnd(usageW)}${String(it.count).padStart(countW)} ${unit.padEnd(4)} added ${it.added ?? "?"}`,
          "dim",
        );
      }
    };
    usageBlock("skills", d.usage.skills, "use", "uses");
    usageBlock("extensions", d.usage.extensions, "run", "runs");
    usageBlock("tools", d.usage.tools, "run", "runs");
  }

  if (d.ratings && (d.ratings.extensions.length > 0 || d.ratings.tools.length > 0)) {
    addR("perf rating (1 cheap · 5 costly)", "accent");
    const rated = [...d.ratings.extensions, ...d.ratings.tools].sort(
      (a, b) => b.rating - a.rating || a.name.localeCompare(b.name),
    );
    const rateW = columnWidth(rated.map((r) => r.name), 14);
    const callsFmt = rated.map((r) => formatNumber(r.calls));
    const callsW = Math.max(4, ...callsFmt.map((s) => s.length));
    for (let i = 0; i < rated.length; i++) {
      const r = rated[i];
      const ms = r.avgMs != null ? `  · avg ${formatMs(r.avgMs)}/call` : "";
      addR(`  ${r.name.padEnd(rateW)}${r.rating} ${callsFmt[i].padStart(callsW)} runs${ms}`, "dim");
    }
    addR("", "default");
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
  const perfData = new PerfStore(opts.perfStorePath).snapshot();
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

  // v1.5: composite perf rating per loaded extension (static source metrics +
  // run count) and per loaded tool (measured durations + run count + impl size)
  const ratings: RatingsSection = { extensions: [], tools: [] };
  for (const e of resources.extensions) {
    const statics = extensionStaticMetrics(e.resolved ?? e.path);
    const calls = usageData.extensions[e.resolved ?? e.path]?.count ?? 0;
    const r = rateItem({
      kind: "extension",
      name: e.name,
      calls,
      avgMs: null,
      bytes: statics?.bytes ?? null,
      subscriptions: statics?.subs ?? 0,
      tuiPerFrame: statics?.tui ?? false,
    });
    ratings.extensions.push({ name: r.name, rating: r.rating, avgMs: r.avgMs, calls: r.calls });
  }
  for (const t of resources.tools) {
    const rec = perfData.tools[t];
    const calls = Math.max(usageData.tools[t]?.count ?? 0, rec?.calls ?? 0);
    const avgMs = rec && rec.calls > 0 ? rec.totalMs / rec.calls : null;
    const r = rateItem({ kind: "tool", name: t, calls, avgMs, bytes: toolImplBytes(t) });
    ratings.tools.push({ name: r.name, rating: r.rating, avgMs: r.avgMs, calls: r.calls });
  }

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
    ratings,
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
  // v1.5: per-call wall clock for the perf store (fallback when pi does not
  // report durationMs; pruned so a missing end event can't leak forever)
  const toolStartTimes = new Map<string, number>();
  pi.on("tool_execution_start", (event) => {
    trackToolUse(event.toolName);
    if (toolStartTimes.size > 2000) toolStartTimes.clear();
    toolStartTimes.set(event.toolCallId, Date.now());
    const name = skillUseFromRead(event.toolName, event.args, skillIndexNow());
    if (name) trackSkillUse(name);
  });
  pi.on("tool_execution_end", (event) => {
    const startAt = toolStartTimes.get(event.toolCallId);
    toolStartTimes.delete(event.toolCallId);
    let ms = typeof event.durationMs === "number" ? event.durationMs : NaN;
    if (!Number.isFinite(ms) || ms <= 0) ms = startAt != null ? Math.max(1, Date.now() - startAt) : NaN;
    if (Number.isFinite(ms) && ms > 0) {
      try {
        new PerfStore().record(event.toolName, ms);
      } catch {
        // counters must never break tool execution
      }
    }
  });
  pi.on("session_start", invalidateSkillIndex);
  pi.on("resources_discover", (event) => {
    invalidateSkillIndex();
    // v1.4: session-start baseline for the changes section (fires with cwd at
    // startup/reload, i.e. session start); in-memory only, never persisted.
    void captureGitBaseline(event.cwd);
  });

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
      // v1.4: git changes arrive asynchronously (first frame renders immediately,
      // the section fills in when the probe answers). The 2 s TTL cache inside
      // collectGitChanges keeps live refreshes from re-spawning git.
      let lastData: StatsData = data;
      let gitProbeInFlight = false;
      const applyGit = (git: GitChangesResult): void => {
        if (git === lastData.git) return;
        lastData = { ...lastData, git };
        comp?.setData(lastData);
      };
      const updateGit = (): void => {
        if (gitProbeInFlight) return;
        gitProbeInFlight = true;
        const baseline = currentGitBaseline();
        void collectGitChanges(ctx.cwd, baseline?.cwd === ctx.cwd ? baseline.head : null)
          .then((git) => {
            gitProbeInFlight = false;
            applyGit(git);
          })
          .catch(() => {
            gitProbeInFlight = false;
          });
      };
      // v1.5: MTP acceptance rate — one tiny LM Studio completion (60 s
      // in-process cache); only for the lmstudio provider; never blocks the UI.
      let mtpTried = false;
      const updateMtp = (): void => {
        if (mtpTried || ctx.model?.provider !== "lmstudio" || !ctx.model?.id) return;
        mtpTried = true;
        void probeMtpAcceptance(ctx.model.id)
          .then((mtp) => {
            if (mtp && mtp !== lastData.mtp) {
              lastData = { ...lastData, mtp };
              comp?.setData(lastData);
            }
          })
          .catch(() => {});
      };

      const refresh = (): void => {
        const now = Date.now();
        if (now - lastRefreshAt < REFRESH_THROTTLE_MS) return;
        lastRefreshAt = now;
        try {
          lastData = { ...collectStats(pi, ctx), git: lastData.git, mtp: lastData.mtp };
          comp?.setData(lastData);
        } catch {
          // keep the last good frame
        }
        updateGit();
        updateMtp();
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
            updateGit(); // kick the probe now so the section fills in right away
            updateMtp(); // same: MTP row fills in without blocking the first frame
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
