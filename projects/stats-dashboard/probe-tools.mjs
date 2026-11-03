import { readFileSync } from "node:fs";
const p = "/home/julian/.pi/agent/sessions/--home-julian--/2026-11-02T16-37-16-956Z_01a19d1f-4e1b-75c3-8a97-806cad6767df.jsonl";
const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
for (const line of lines) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.type === "message" && e.message?.role === "system") {
    console.log("keys:", Object.keys(e.message));
    console.log("content type:", typeof e.message.content, Array.isArray(e.message.content) ? "array len " + e.message.content.length : "");
    const s = JSON.stringify(e.message).slice(0, 400);
    console.log(s);
    break;
  }
}
