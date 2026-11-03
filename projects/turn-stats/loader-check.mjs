// Verify turn-stats.ts loads through pi's real extension loader (jiti).
// Mirrors stats-dashboard/v15-loader-check.mjs; fails only on turn-stats problems.
const INSTALL = "/home/julian/.pi/agent/install/releases/1.5.0/node_modules";
const { createJiti } = await import(INSTALL + "/jiti/lib/jiti.mjs");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { discoverAndLoadExtensions, getAgentDir } = await jiti.import("@earendil-works/pi-coding-agent");

const result = await discoverAndLoadExtensions([], "/home/julian", getAgentDir());
console.log("loaded:", result.extensions.map((e) => e.path.split("/").pop()));
const tsErrors = result.errors.filter((e) => String(e).includes("turn-stats"));
console.log("turn-stats errors:", tsErrors.length ? tsErrors : "none");

const ext = result.extensions.find((e) => e.path.endsWith("turn-stats.ts"));
if (!ext) {
  console.log("turn-stats.ts NOT LOADED");
  process.exit(1);
}
const handlers = [...(ext.handlers ?? new Map()).keys()];
console.log("turn-stats.ts handlers:", handlers.join(", "));
const ok =
  tsErrors.length === 0 &&
  handlers.includes("agent_start") &&
  handlers.includes("message_end") &&
  handlers.includes("agent_settled");
console.log(ok ? "OK" : "CHECK FAILED");
process.exit(ok ? 0 : 1);
