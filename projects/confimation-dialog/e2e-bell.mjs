#!/usr/bin/env node
/**
 * End-to-end test of the bell feature — through the REAL pi (RPC mode).
 *
 * Flow:
 *   1. Starts `pi --mode rpc --no-session` in a fresh temp dir.
 *   2. Prompts the agent to run `git init .` (a gated command).
 *   3. Waits for the `extension_ui_request` (method "confirm", title
 *      "confirmation-dialog") — proof the dialog really popped up.
 *      At that instant it checks whether an ffplay process is alive:
 *      => the bell rang AT DIALOG TIME (the new behavior).
 *   4. Answers `confirmed: false` => the command must be blocked
 *      (no .git dir may be created in the temp dir).
 *   5. On `agent_settled` checks for an ffplay process shortly after:
 *      => the old turn-end bell still works.
 *   6. Kills pi, cleans up, prints PASS/FAIL.
 *
 * You will HEAR the bell(s) — that is the point of this test.
 *
 * Usage:  node e2e-bell.mjs        (or: npm run test:e2e)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TIMEOUT_MS = 180_000;
const workdir = mkdtempSync(path.join(tmpdir(), "pi-bell-e2e-"));

const t0 = Date.now();
const ms = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${ms()}]`, ...a);
const sleep = (n) => new Promise((r) => setTimeout(r, n));

function ffplayPids() {
  const pids = [];
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
        if (/\bffplay\b/.test(cmd)) pids.push(pid);
      } catch {}
    }
  } catch {}
  return pids;
}

async function waitFfplay(maxMs) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const p = ffplayPids();
    if (p.length) return p;
    await sleep(50);
  }
  return [];
}

const results = {
  dialogShown: false,
  bellAtDialog: false,
  commandBlocked: true,
  settleBell: false,
};

const lastEvents = [];
let dialogHandled = false;
let finished = false;

const pi = spawn("pi", ["--mode", "rpc", "--no-session"], {
  cwd: workdir,
  stdio: ["pipe", "pipe", "pipe"],
});

pi.stderr.on("data", (d) => process.stderr.write(`[pi:stderr] ${d}`));

function send(obj) {
  pi.stdin.write(JSON.stringify(obj) + "\n");
}

function finish() {
  if (finished) return;
  finished = true;
  results.commandBlocked = !existsSync(path.join(workdir, ".git"));

  const checks = [
    ["dialog really popped up (confirm request seen)", results.dialogShown],
    ["bell rang AT DIALOG TIME (ffplay alive)", results.bellAtDialog],
    ["command was blocked after decline (no .git created)", results.commandBlocked],
    ["turn-end bell still works (old behavior)", results.settleBell],
  ];
  const ok = checks.every(([, v]) => v);
  console.log("\n===== E2E RESULT =====");
  for (const [name, v] of checks) console.log(`  ${v ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log("  recent events:", lastEvents.join(", ") || "(none)");
  console.log(ok ? "\nE2E: ALL PASS" : "\nE2E: FAILURES PRESENT");

  pi.kill("SIGINT");
  setTimeout(() => {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {}
    process.exit(ok ? 0 : 1);
  }, 1500).unref();
}

pi.stdout.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      log("non-JSON line:", s.slice(0, 120));
      continue;
    }

    // ── the dialog: the moment of truth for the new bell ──
    if (rec.type === "extension_ui_request") {
      if (rec.method === "confirm" && rec.title === "confirmation-dialog") {
        if (dialogHandled) continue;
        dialogHandled = true;
        results.dialogShown = true;
        log(`DIALOG SHOWN: "${rec.title}" — ${String(rec.message).slice(0, 80).replace(/\n/g, " | ")}`);
        const immediate = ffplayPids();
        if (immediate.length) {
          results.bellAtDialog = true;
          log(`BELL AT DIALOG: ffplay alive (pid ${immediate.join(",")})`);
        } else {
          // ffplay spawn can lag a few ms behind the protocol record
          void waitFfplay(1000).then((p) => {
            if (p.length) {
              results.bellAtDialog = true;
              log(`BELL AT DIALOG: ffplay alive (pid ${p.join(",")}, within 1s)`);
            } else {
              log("NO BELL at dialog time");
            }
          });
        }
        send({ id: rec.id, type: "extension_ui_response", confirmed: false });
        log("answered dialog: confirmed=false (decline)");
      } else {
        log(`other UI request: ${rec.method} "${rec.title}"`);
        send({ id: rec.id, type: "extension_ui_response", cancelled: true }); // never hang
      }
      return;
    }

    // ── pi is ready -> prompt it to run a gated command ──
    if (rec.type === "response" && rec.command === "get_state") {
      log("pi ready, sending prompt");
      send({
        id: "req-prompt",
        type: "prompt",
        message:
          "Using your bash tool, run EXACTLY this single command: git init .\n" +
          "Do not run any other commands and do not read or write files. " +
          "If the command is blocked, do not retry it in another form; just say it was blocked.",
      });
      return;
    }

    // ── turn finished: check the OLD bell still works ──
    if (rec.type === "agent_settled") {
      log(`agent_settled (aborted=${rec.aborted}) — checking turn-end bell`);
      void waitFfplay(3000).then((p) => {
        if (p.length) {
          results.settleBell = true;
          log(`SETTLE BELL: ffplay alive (pid ${p.join(",")})`);
        } else {
          log("no settle bell observed");
        }
        finish();
      });
      return;
    }

    lastEvents.push(rec.type ?? "?");
    if (lastEvents.length > 40) lastEvents.shift();
  }
});

pi.on("exit", (code) => {
  log(`pi exited (code ${code})`);
  finish();
});

// ask pi for state (doubles as the "ready" signal)
send({ id: "req-state", type: "get_state" });

setTimeout(() => {
  log(`TIMEOUT after ${TIMEOUT_MS / 1000}s — recent events: ${lastEvents.join(", ")}`);
  finish();
}, TIMEOUT_MS);
