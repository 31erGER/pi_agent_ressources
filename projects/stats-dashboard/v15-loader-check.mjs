// Verify stats.ts loads through pi's real extension loader (jiti)
const INSTALL = "/home/julian/.pi/agent/install/releases/1.5.0/node_modules";
const { createJiti } = await import(INSTALL + "/jiti/lib/jiti.mjs");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { discoverAndLoadExtensions, getAgentDir } = await jiti.import("@earendil-works/pi-coding-agent");
const result = await discoverAndLoadExtensions([], "/home/julian", getAgentDir());
console.log("loaded:", result.extensions.map((e) => e.path.split("/").pop()));
console.log("errors:", result.errors.length);
const stats = result.extensions.find((e) => e.path.endsWith("stats.ts"));
if (stats) {
  console.log("stats.ts commands:", [...(stats.commands ?? new Map()).keys()]);
} else {
  console.log("stats.ts NOT LOADED");
}
process.exit(result.errors.length === 0 && stats ? 0 : 1);
