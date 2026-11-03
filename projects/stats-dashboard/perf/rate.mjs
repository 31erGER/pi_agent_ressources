#!/usr/bin/env node
/**
 * perf/rate.mjs — generate perf/perf-ratings.json from the global measurement
 * stores.
 *
 * Inputs:
 *   ~/.pi/agent/perf-stats.json    tool durations (calls/totalMs/maxMs per tool)
 *   ~/.pi/agent/usage-stats.json   run counts (tools, extensions, skills)
 *   extension source files         static metrics (size, pi.on() count, TUI usage)
 *
 * Override the store locations with PI_STATS_PERF_FILE / PI_STATS_USAGE_FILE.
 *
 * Run:  node perf/rate.mjs      (from ~/.pi/agent/projects/stats-dashboard)
 * The /stats dashboard reads its ratings live from the stores; this script is
 * the standalone "write the ratings to a file" deliverable + the reference
 * implementation of the criteria (see ../PERFORMANCE-RATING.md).
 */
import fs from "node:fs";
import path from "node:path";

const {
  PerfStore,
  UsageStore,
  rateItem,
  extensionStaticMetrics,
  toolImplBytes,
  RATING_BANDS,
  RATING_WEIGHTS,
} = await import("../../../extensions/stats.ts");
const { getAgentDir } = await import("@earendil-works/pi-coding-agent");

const perf = new PerfStore().snapshot();
const usage = new UsageStore().snapshot();

// --- extensions: agent dir + ./.pi/extensions (same discovery the dashboard uses, simplified)
const extDirs = [
  path.join(getAgentDir(), "extensions"),
  path.join(process.cwd(), ".pi", "extensions"),
];
const extFiles = [];
const seenDirs = new Set();
for (const dir of extDirs) {
  if (seenDirs.has(dir) || !fs.existsSync(dir)) continue;
  seenDirs.add(dir);
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".ts") || f.endsWith(".js")) extFiles.push(path.join(dir, f));
  }
}
const extensions = extFiles.map((p) => {
  const statics = extensionStaticMetrics(p);
  const calls = usage.extensions[path.resolve(p)]?.count ?? 0;
  const r = rateItem({
    kind: "extension",
    name: path.basename(p),
    calls,
    avgMs: null,
    bytes: statics?.bytes ?? null,
    subscriptions: statics?.subs ?? 0,
    tuiPerFrame: statics?.tui ?? false,
  });
  return {
    name: path.basename(p),
    kind: "extension",
    rating: r.rating,
    duration: r.duration,
    frequency: r.frequency,
    static: r.static,
    calls,
    avgMs: null,
    bytes: statics?.bytes ?? null,
    subscriptions: statics?.subs ?? 0,
    tuiPerFrame: statics?.tui ?? false,
  };
});

// --- tools: union of perf-store and usage-store tool names
const toolNames = new Set([...Object.keys(perf.tools), ...Object.keys(usage.tools)]);
const tools = [...toolNames].map((t) => {
  const rec = perf.tools[t];
  const calls = Math.max(usage.tools[t]?.count ?? 0, rec?.calls ?? 0);
  const avgMs = rec && rec.calls > 0 ? rec.totalMs / rec.calls : null;
  const bytes = toolImplBytes(t);
  const r = rateItem({ kind: "tool", name: t, calls, avgMs, bytes });
  return {
    name: t,
    kind: "tool",
    rating: r.rating,
    duration: r.duration,
    frequency: r.frequency,
    static: r.static,
    calls,
    avgMs,
    maxMs: rec?.maxMs ?? null,
    bytes,
  };
});

const out = {
  generatedAt: new Date().toISOString(),
  scale: "1 (cheapest) … 5 (most costly)",
  weights: { ...RATING_WEIGHTS },
  bands: { ...RATING_BANDS },
  sources: {
    perf: process.env.PI_STATS_PERF_FILE || path.join(getAgentDir(), "perf-stats.json"),
    usage: process.env.PI_STATS_USAGE_FILE || path.join(getAgentDir(), "usage-stats.json"),
  },
  items: [...extensions, ...tools].sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name)),
};

const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), "perf-ratings.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath} (${out.items.length} rated items)`);
for (const it of out.items) {
  const ms = it.avgMs != null ? `  avg ${Math.round(it.avgMs)}ms` : "";
  console.log(`  ${it.kind.padEnd(10)} ${it.name.padEnd(24)} rating ${it.rating}${ms}  (${it.calls} runs)`);
}
