/**
 * e2e.mjs — end-to-end test for the LM Studio effort mapping (PLAN.md step 4).
 *
 * Run: node /home/julian/.pi/agent/projects/lmstudio/e2e.mjs
 *
 * Spins up a mock OpenAI-compatible LM Studio server on 127.0.0.1 (random port),
 * then runs the real `pi` CLI in print mode against it (global extensions load,
 * so extensions/lmstudio.ts + the efforts.json auto-creation are exercised for
 * real). Asserts that the captured /v1/chat/completions JSON body contains the
 * expected `reasoning_effort` per thinking level:
 *
  *   - --thinking off               -> "none" (pi's built-in default is "medium")
 *   - --thinking high              -> "high"
 *   - --thinking max               -> "xhigh"
 *   - non-reasoning model          -> field ABSENT (regression guard)
 *
 * Exit code 0 = all assertions passed.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_BIN = "/home/julian/.pi/agent/bin/pi";
const RUN_CWD = "/tmp/lmstudio-e2e-run"; // stable temp cwd (no .pi project -> no trust prompt; one session dir)
const RUN_TIMEOUT_MS = 120_000;

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -> ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// ------------------------------------------------------------------ mock server

const captured = []; // { model, body } per POST /v1/chat/completions

function sseChunk(model, delta, finishReason = null, usage = null) {
  const msg = { id: "cmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
  if (usage) msg.usage = usage;
  return `data: ${JSON.stringify(msg)}\n\n`;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/v0/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "mock-thinking-model", type: "llm", state: "loaded", publisher: "LLMs", max_context_length: 32000 },
          { id: "mock-plain-model", type: "llm", state: "loaded", publisher: "LLMs", max_context_length: 32000 },
        ],
      }),
    );
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-thinking-model" }, { id: "mock-plain-model" }] }));
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
      captured.push({ body });
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

function runPi(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    // Strip ALL PI_* vars: this script runs inside a live pi session and the child
    // must never inherit PI_SESSION_ID/PI_SESSION_FILE (would resume this session).
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PI_"))),
      ...extraEnv,
    };
    const child = spawn(PI_BIN, args, {
      cwd: RUN_CWD,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi run timed out after ${RUN_TIMEOUT_MS}ms: ${args.join(" ")}`));
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`pi exited ${code}\nstdout: ${stdout.slice(-500)}\nstderr: ${stderr.slice(-500)}`));
    });
  });
}

// --------------------------------------------------------------------------- run

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lmstudio-e2e-"));
const effortsPath = path.join(tmp, "efforts.json");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

function lmEnv() {
  return { LM_STUDIO_BASE_URL: baseUrl, LM_STUDIO_EFFORTS_FILE: effortsPath };
}

function bodiesSince(idx) {
  return captured.slice(idx);
}

async function case1_off() {
  const start = captured.length;
  const r = await runPi(["--print", "Reply with the single word: ok", "--provider", "lmstudio", "--model", "mock-thinking-model", "--thinking", "off"], lmEnv());
  // pi's built-in DEFAULT_THINKING_LEVEL is "medium" (core/defaults.js), so the off
  // mapping is tested explicitly.
  check("off: pi exited 0 and replied 'ok'", r.stdout.trim() === "ok", JSON.stringify(r.stdout.slice(-200)));
  const bodies = bodiesSince(start);
  check("off: exactly one completion request", bodies.length === 1, `got ${bodies.length}`);
  const effort = bodies[0]?.body?.reasoning_effort;
  check('--thinking off: reasoning_effort === "none"', effort === "none", `got ${JSON.stringify(effort)}`);
}

async function case2_high() {
  const start = captured.length;
  const r = await runPi(["--print", "Reply with the single word: ok", "--provider", "lmstudio", "--model", "mock-thinking-model", "--thinking", "high"], lmEnv());
  check("high: pi exited 0 and replied 'ok'", r.stdout.trim() === "ok", JSON.stringify(r.stdout.slice(-200)));
  const bodies = bodiesSince(start);
  check("high: exactly one completion request", bodies.length === 1, `got ${bodies.length}`);
  const effort = bodies[0]?.body?.reasoning_effort;
  check('--thinking high: reasoning_effort === "high"', effort === "high", `got ${JSON.stringify(effort)}`);
}

async function case3_max() {
  const start = captured.length;
  const r = await runPi(["--print", "Reply with the single word: ok", "--provider", "lmstudio", "--model", "mock-thinking-model", "--thinking", "max"], lmEnv());
  check("max: pi exited 0 and replied 'ok'", r.stdout.trim() === "ok", JSON.stringify(r.stdout.slice(-200)));
  const bodies = bodiesSince(start);
  check("max: exactly one completion request", bodies.length === 1, `got ${bodies.length}`);
  const effort = bodies[0]?.body?.reasoning_effort;
  check('--thinking max: reasoning_effort === "xhigh" (mapped)', effort === "xhigh", `got ${JSON.stringify(effort)}`);
}

async function case4_plainModel() {
  const start = captured.length;
  const r = await runPi(["--print", "Reply with the single word: ok", "--provider", "lmstudio", "--model", "mock-plain-model"], lmEnv());
  check("plain: pi exited 0 and replied 'ok'", r.stdout.trim() === "ok", JSON.stringify(r.stdout.slice(-200)));
  const bodies = bodiesSince(start);
  check("plain: exactly one completion request", bodies.length === 1, `got ${bodies.length}`);
  const body = bodies[0]?.body ?? {};
  check("plain model: reasoning_effort ABSENT", !("reasoning_effort" in body), `got ${JSON.stringify(body.reasoning_effort)}`);
}

await fs.mkdir(RUN_CWD, { recursive: true });
await case1_off();
await case2_high();
await case3_max();
await case4_plainModel();

// Efforts file auto-creation (PLAN.md acceptance criterion 4, temp variant):
try {
  const file = JSON.parse(await fs.readFile(effortsPath, "utf8"));
  check("efforts.json created with entry for mock-thinking-model", file["mock-thinking-model"] !== undefined);
  check("efforts.json created with entry for mock-plain-model", file["mock-plain-model"] !== undefined);
  const e = file["mock-thinking-model"] ?? {};
  check(
    "auto entry defaults (off=none, max=xhigh, high=high)",
    e.off === "none" && e.max === "xhigh" && e.high === "high" && e.xhigh === "xhigh",
    JSON.stringify(e),
  );
} catch (err) {
  check("efforts.json readable after runs", false, String(err));
}

server.close();
await fs.rm(tmp, { recursive: true, force: true });

console.log(failures.length === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures.length} E2E CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
