/**
 * e2e.mjs — RPC-mode end-to-end test for the /efforts extension (PLAN.md step 4).
 *
 * Run: node /home/julian/.pi/agent/projects/dynamic-readoning-levels/e2e.mjs
 *
 * Mock LM Studio server (127.0.0.1, random port) + real `pi --mode rpc` child
 * (global extensions load, so extensions/lmstudio.ts + /efforts are exercised
 * for real). Acceptance criteria covered:
 *
 *   AC2: /efforts off,high,xhigh changes the active model's level set LIVE
 *        (get_available_thinking_levels before/after — no restart)
 *   AC3: next chat request sends the mapped value as reasoning_effort
 *        (captured /v1/chat/completions body); narrowed set clamps the level
 *   AC4: a model that appears on the server is picked up by the native
 *        /lmstudio refresh, selected via set_model, and gets auto default entry
 *
 * Exit code 0 = all assertions passed.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DEFAULT_ENTRY } from "../lmstudio/lmstudio-efforts.ts";

const PI_BIN = "/home/julian/.pi/agent/bin/pi";
const RUN_CWD = "/tmp/dynamic-thinking-e2e-run"; // stable temp cwd (no project .pi -> no trust prompt)
const RPC_TIMEOUT_MS = 30_000;

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -> ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// ------------------------------------------------------------------ mock server

const catalog = [
  { id: "mock-thinking-model", type: "llm", state: "loaded", publisher: "LLMs", max_context_length: 32000 },
];
const captured = []; // { model, body } per POST /v1/chat/completions

function sseChunk(model, delta, finishReason = null, usage = null) {
  const msg = { id: "cmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
  if (usage) msg.usage = usage;
  return `data: ${JSON.stringify(msg)}\n\n`;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/v0/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: catalog }));
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: catalog.map((m) => ({ id: m.id })) }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      captured.push({ model: body.model, body });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const model = body.model ?? "mock";
      res.write(sseChunk(model, { role: "assistant", content: "" }));
      res.write(sseChunk(model, { content: "ok" }));
      res.write(sseChunk(model, {}, "stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `mock: ${req.method} ${req.url} not found` } }));
});

// ------------------------------------------------------------------ rpc client

function makeRpcClient(child) {
  let nextId = 0;
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (c) => {
    buffer += c;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "response" && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  return {
    request(type, params = {}) {
      const id = `req_${++nextId}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC ${type} timed out after ${RPC_TIMEOUT_MS}ms`));
        }, RPC_TIMEOUT_MS);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ type, id, ...params })}\n`);
      });
    },
  };
}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// --------------------------------------------------------------------------- run

await fs.mkdir(RUN_CWD, { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dynamic-thinking-e2e-"));
const effortsPath = path.join(tmp, "efforts.json");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// Strip ALL PI_* vars: this script may run inside a live pi session and the
// child must never inherit PI_SESSION_ID/PI_SESSION_FILE (would resume it).
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PI_"))),
  LM_STUDIO_BASE_URL: baseUrl,
  LM_STUDIO_EFFORTS_FILE: effortsPath,
};

const child = spawn(
  PI_BIN,
  ["--mode", "rpc", "--provider", "lmstudio", "--model", "mock-thinking-model", "--thinking", "high"],
  { cwd: RUN_CWD, env, stdio: ["pipe", "pipe", "pipe"] },
);
let childStderr = "";
child.stderr.on("data", (c) => (childStderr += c));
const rpc = makeRpcClient(child);

try {
  // ---- baseline: default auto-created entry -> all seven levels
  const state0 = await rpc.request("get_state");
  check("get_state succeeds", state0.success === true, JSON.stringify(state0).slice(0, 300));
  check(
    "initial model is the mock reasoning model at level high",
    state0.data?.model?.id === "mock-thinking-model" && state0.data?.thinkingLevel === "high",
    JSON.stringify({ model: state0.data?.model?.id, level: state0.data?.thinkingLevel }),
  );
  const levels0 = await rpc.request("get_available_thinking_levels");
  check(
    "baseline levels = full default set (7)",
    JSON.stringify(levels0.data?.levels) === JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    JSON.stringify(levels0.data?.levels),
  );

  // ---- AC2: /efforts narrows the set live (no restart)
  const cmd1 = await rpc.request("prompt", { message: "/efforts off,high,xhigh" });
  check("/efforts command accepted", cmd1.success === true, JSON.stringify(cmd1).slice(0, 300));
  const levels1 = await waitFor(async () => {
    const r = await rpc.request("get_available_thinking_levels");
    return JSON.stringify(r.data?.levels) === JSON.stringify(["off", "high", "xhigh"]) ? r : null;
  }, "AC2 narrowed levels");
  check(
    "AC2: levels narrowed live to off,high,xhigh",
    JSON.stringify(levels1.data?.levels) === JSON.stringify(["off", "high", "xhigh"]),
    JSON.stringify(levels1.data?.levels),
  );
  const state1 = await rpc.request("get_state");
  check(
    "level preserved (high is in the narrowed set) and model map updated",
    state1.data?.thinkingLevel === "high" &&
      state1.data?.model?.thinkingLevelMap?.minimal === null &&
      state1.data?.model?.thinkingLevelMap?.high === "high",
    JSON.stringify({ level: state1.data?.thinkingLevel, map: state1.data?.model?.thinkingLevelMap }),
  );

  // ---- AC3: chat request carries the mapped reasoning_effort
  const prompt1 = await rpc.request("prompt", { message: "hi" });
  check("prompt accepted", prompt1.success === true, JSON.stringify(prompt1).slice(0, 300));
  const body1 = await waitFor(() => captured.at(-1)?.body?.model === "mock-thinking-model" ? captured.at(-1) : null, "chat body");
  check(
    "AC3: reasoning_effort = mapped value of current level (high -> high)",
    body1.body.reasoning_effort === "high",
    JSON.stringify({ effort: body1.body.reasoning_effort }),
  );

  // ---- clamp: narrow further so the current level disappears
  const cmd2 = await rpc.request("prompt", { message: "/efforts off,low" });
  check("/efforts off,low accepted", cmd2.success === true, JSON.stringify(cmd2).slice(0, 300));
  const levels2 = await waitFor(async () => {
    const r = await rpc.request("get_available_thinking_levels");
    return JSON.stringify(r.data?.levels) === JSON.stringify(["off", "low"]) ? r : null;
  }, "clamped levels");
  const state2 = await rpc.request("get_state");
  check(
    "levels narrowed to off,low and high clamped into the set",
    JSON.stringify(levels2.data?.levels) === JSON.stringify(["off", "low"]) &&
      ["off", "low"].includes(state2.data?.thinkingLevel),
    JSON.stringify({ levels: levels2.data?.levels, level: state2.data?.thinkingLevel }),
  );

  // ---- AC4: new model appears -> native /lmstudio refresh -> set_model -> defaults
  // capabilities: ["thinking"] so the existing extension's isReasoningModel
  // (capabilities OR id-pattern) detects it as a reasoning model.
  catalog.push({ id: "mock-new-model", type: "llm", state: "loaded", publisher: "LLMs", max_context_length: 32000, capabilities: ["thinking"] });
  const cmd3 = await rpc.request("prompt", { message: "/lmstudio" });
  check("/lmstudio refresh accepted", cmd3.success === true, JSON.stringify(cmd3).slice(0, 300));
  await waitFor(async () => (await rpc.request("get_available_models")).data?.models?.some((m) => m.id === "mock-new-model"), "new model in registry");
  const setm = await rpc.request("set_model", { provider: "lmstudio", modelId: "mock-new-model" });
  check("set_model to new model succeeds", setm.success === true, JSON.stringify(setm).slice(0, 300));
  const levels3 = await rpc.request("get_available_thinking_levels");
  check(
    "AC4: new model gets auto default entry (full 7-level set)",
    JSON.stringify(levels3.data?.levels) === JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    JSON.stringify(levels3.data?.levels),
  );
  const prompt2 = await rpc.request("prompt", { message: "hi" });
  check("second prompt accepted", prompt2.success === true, JSON.stringify(prompt2).slice(0, 300));
  const body2 = await waitFor(() => captured.at(-1)?.body?.model === "mock-new-model" ? captured.at(-1) : null, "new-model chat body");
  const state3 = await rpc.request("get_state");
  const expectedEffort = DEFAULT_ENTRY[state3.data?.thinkingLevel] ?? "none";
  check(
    "AC4: new model's request carries the mapped reasoning_effort",
    body2.body.reasoning_effort === expectedEffort,
    JSON.stringify({ level: state3.data?.thinkingLevel, effort: body2.body.reasoning_effort, expected: expectedEffort }),
  );

  // ---- file on disk holds the arrays (unlisted levels null)
  const onDisk = JSON.parse(await fs.readFile(effortsPath, "utf8"));
  check(
    "efforts.json: narrowed entry for mock-thinking-model (unlisted -> null)",
    JSON.stringify(onDisk["mock-thinking-model"]) ===
      JSON.stringify({ off: "none", minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null }),
    JSON.stringify(onDisk["mock-thinking-model"]),
  );
  check(
    "efforts.json: auto-created default entry for mock-new-model",
    JSON.stringify(onDisk["mock-new-model"]) === JSON.stringify({ ...DEFAULT_ENTRY }),
    JSON.stringify(onDisk["mock-new-model"]),
  );
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    await new Promise((r) => {
      child.once("close", r);
      const t = setTimeout(r, 3000);
      t.unref();
    });
  }
  server.close();
}

console.log(failures.length === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures.length} FAILURES:\n${childStderr.slice(-800)}`);
process.exit(failures.length === 0 ? 0 : 1);
