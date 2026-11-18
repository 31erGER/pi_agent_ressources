// v1.6 identity check: does the jiti-loaded stats.ts factory patch the SAME
// AgentSession class that a native pi process uses?
// Models production: native pi import (like the pi CLI) + real extension loader
// (discoverAndLoadExtensions) + real extensions in ~/.pi/agent/extensions.
const INSTALL = "/home/julian/.pi/agent/install/releases/1.5.0/node_modules";
const pi = await import(INSTALL + "/@earendil-works/pi-coding-agent/dist/index.js");
const result = await pi.discoverAndLoadExtensions([], "/home/julian", pi.getAgentDir());
console.log("loaded:", result.extensions.map((e) => e.path.split("/").pop()).join(", "));
console.log("errors:", result.errors.length);
const stats = result.extensions.find((e) => e.path.endsWith("stats.ts"));
console.log("stats.ts commands:", stats ? [...(stats.commands ?? new Map()).keys()].join(", ") : "NOT LOADED");
const proto = pi.AgentSession.prototype;
const installed = proto.__statsCommandTracked === true;
console.log("tracker installed on native AgentSession.prototype:", installed);
process.exit(result.errors.length === 0 && stats && installed ? 0 : 1);
