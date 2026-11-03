import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

process.env.PI_STATS_USAGE_FILE = "/tmp/v13-loader-usage.json";
const result = await discoverAndLoadExtensions([], "/home/julian", "/home/julian/.pi/agent");
console.log("loaded:", result.extensions.map((e) => e.path.split("/").pop()).join(", "));
console.log("errors:", result.errors.length);
for (const e of result.errors) console.log("  ERR:", e.path, e.error?.message ?? e.error);
const stats = result.extensions.find((e) => e.path.endsWith("stats.ts"));
console.log("stats.ts commands:", [...(stats?.commands?.keys?.() ?? [])].join(","));
const mod = await import("/home/julian/.pi/agent/extensions/stats.ts");
console.log(
  "exports ok:",
  typeof mod.piPackageRoot === "function",
  typeof mod.parseToolList === "function",
  typeof mod.buildStatsColumns === "function",
);
console.log("piPackageRoot:", mod.piPackageRoot());
const tid = (n) => (mod.toolIntroducedDate(n) ? new Date(mod.toolIntroducedDate(n)).toISOString().slice(0, 10) : null);
console.log("toolIntroducedDate(read):", tid("read"));
console.log("toolIntroducedDate(bash):", tid("bash"));
console.log("toolIntroducedDate(custom-mcp-tool):", tid("custom-mcp-tool"));
