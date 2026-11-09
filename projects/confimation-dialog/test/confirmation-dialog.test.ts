/**
 * Tests for ~/.pi/agent/extensions/confirmation-dialog.ts
 *
 * Run:  npm test   (from this project root)
 *
 * The suite stays silent: tests install a spy bell via setChime(), so no
 * ffplay process and no sound are ever triggered. The real audio path is
 * deliberately NOT exercised here (tests must not make noise).
 */
import test from "node:test";
import assert from "node:assert/strict";

import confirmationDialog, {
  classify,
  setChime,
} from "../../../extensions/confirmation-dialog.ts";
import { chime as realChime } from "../../../extensions/notify-on-settle.ts";

function makePi() {
  const handlers: Record<string, Array<(e: any, ctx: any) => unknown>> = {};
  const pi = {
    on(name: string, h: (e: any, ctx: any) => unknown) {
      (handlers[name] ??= []).push(h);
    },
  };
  return { pi, handlers };
}

function makeCtx(confirmImpl: () => Promise<boolean> | boolean, opts: { hasUI?: boolean } = {}) {
  return { hasUI: opts.hasUI ?? true, ui: { confirm: confirmImpl } };
}

async function runBash(
  handlers: Record<string, Array<(e: any, ctx: any) => unknown>>,
  command: string,
  ctx: any,
): Promise<any> {
  assert.equal(handlers.tool_call?.length, 1);
  return handlers.tool_call[0]({ toolName: "bash", input: { command } }, ctx);
}

// ── loading ──────────────────────────────────────────────────────────────────

test("default export registers exactly one tool_call handler", () => {
  const { pi, handlers } = makePi();
  confirmationDialog(pi);
  assert.equal(handlers.tool_call.length, 1);
});

// ── classify: pre-existing behavior, must stay green ────────────────────────

test("classify: read-only git passes, mutating git asks", () => {
  assert.equal(classify("git status"), null);
  assert.equal(classify("git log -n 5"), null);
  assert.ok(classify("git commit -m x"));
  assert.ok(classify("git push origin main"));
  assert.ok(classify("git init"));
});

test("classify: recursive rm asks, plain rm passes", () => {
  assert.ok(classify("rm -rf /tmp/x"));
  assert.ok(classify("rm -r dir"));
  assert.equal(classify("rm file.txt"), null);
  assert.equal(classify("echo hello"), null);
});

// ── bell: the new behavior ───────────────────────────────────────────────────

test("rings the bell exactly once, right before the dialog (allow)", async (t) => {
  t.after(() => setChime(null));
  const { pi, handlers } = makePi();
  confirmationDialog(pi);
  const calls: string[] = [];
  setChime(() => calls.push("chime"));
  const ctx = makeCtx(async () => {
    calls.push("confirm");
    return true;
  });
  const res = await runBash(handlers, "git commit -m x", ctx);
  assert.equal(res, undefined, "allowed -> no block");
  assert.deepEqual(calls, ["chime", "confirm"], "bell first, then the dialog appears");
});

test("rings the bell once on decline and still blocks", async (t) => {
  t.after(() => setChime(null));
  const { pi, handlers } = makePi();
  confirmationDialog(pi);
  const calls: string[] = [];
  setChime(() => calls.push("chime"));
  const ctx = makeCtx(async () => {
    calls.push("confirm");
    return false;
  });
  const res = await runBash(handlers, "rm -rf /tmp/x", ctx);
  assert.equal(res?.block, true, "declined -> blocked");
  assert.ok(res?.reason, "block carries a reason");
  assert.deepEqual(calls, ["chime", "confirm"]);
});

test("safe command: no bell, no dialog", async (t) => {
  t.after(() => setChime(null));
  const { pi, handlers } = makePi();
  confirmationDialog(pi);
  const calls: string[] = [];
  setChime(() => calls.push("chime"));
  const ctx = makeCtx(async () => {
    calls.push("confirm");
    return true;
  });
  const res = await runBash(handlers, "git status", ctx);
  assert.equal(res, undefined);
  assert.equal(calls.length, 0, "no bell, no dialog for safe commands");
});

test("no UI (print/JSON mode): blocked, and no bell (nothing to interact with)", async (t) => {
  t.after(() => setChime(null));
  const { pi, handlers } = makePi();
  confirmationDialog(pi);
  const calls: string[] = [];
  setChime(() => calls.push("chime"));
  const ctx = makeCtx(async () => true, { hasUI: false });
  const res = await runBash(handlers, "git commit -m x", ctx);
  assert.equal(res?.block, true);
  assert.equal(calls.length, 0);
});

test("non-bash tools are ignored: no bell, no dialog", async (t) => {
  t.after(() => setChime(null));
  const { pi, handlers } = makePi();
  confirmationDialog(pi);
  const calls: string[] = [];
  setChime(() => calls.push("chime"));
  const ctx = makeCtx(async () => {
    calls.push("confirm");
    return true;
  });
  const res = await handlers.tool_call[0]({ toolName: "read", input: {} }, ctx);
  assert.equal(res, undefined);
  assert.equal(calls.length, 0);
});

test("dialog error still blocks (bell already rang)", async (t) => {
  t.after(() => setChime(null));
  const { pi, handlers } = makePi();
  confirmationDialog(pi);
  const calls: string[] = [];
  setChime(() => calls.push("chime"));
  const ctx = makeCtx(async () => {
    calls.push("confirm");
    throw new Error("ui failed");
  });
  const res = await runBash(handlers, "git push origin main", ctx);
  assert.equal(res?.block, true, "fail-safe: dialog error blocks the command");
  assert.deepEqual(calls, ["chime", "confirm"]);
});

test("a broken bell never blocks the dialog or the gate", async (t) => {
  t.after(() => setChime(null));
  const { pi, handlers } = makePi();
  confirmationDialog(pi);
  const calls: string[] = [];
  setChime(() => {
    throw new Error("boom");
  });
  const ctx = makeCtx(async () => {
    calls.push("confirm");
    return true;
  });
  const res = await runBash(handlers, "git commit -m x", ctx);
  assert.equal(res, undefined, "bell failure must not block an allowed command");
  assert.deepEqual(calls, ["confirm"], "the dialog still appears");
});

// ── default wiring ───────────────────────────────────────────────────────────

test("default bell is the exported chime of notify-on-settle", () => {
  // The static import in confirmation-dialog.ts is this very function;
  // setChime(null) restores it. Real audio is not played in tests.
  assert.equal(typeof realChime, "function");
});
