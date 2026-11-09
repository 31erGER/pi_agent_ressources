/**
 * Tests for ~/.pi/agent/extensions/notify-on-settle.ts
 *
 * NOTE: no test invokes the settled handler with a non-aborted event —
 * that would spawn ffplay and actually play a sound. The chime() export is
 * only checked for existence/signature; confirmation-dialog.test.ts covers
 * the dialog-triggered wiring with a spy bell.
 */
import test from "node:test";
import assert from "node:assert/strict";

import notifyOnSettle, { chime } from "../../../extensions/notify-on-settle.ts";

test("chime is exported as a function (used by confirmation-dialog)", () => {
  assert.equal(typeof chime, "function");
});

test("default export registers exactly one agent_settled handler", () => {
  const handlers: Record<string, unknown[]> = {};
  notifyOnSettle({ on: (name: string, h: unknown) => ((handlers[name] ??= []).push(h)) });
  assert.equal(handlers.agent_settled?.length, 1);
});

test("settled handler keeps registering alongside (no double registration on reload)", () => {
  const handlers: Record<string, unknown[]> = {};
  const pi = { on: (name: string, h: unknown) => ((handlers[name] ??= []).push(h)) };
  notifyOnSettle(pi);
  notifyOnSettle(pi); // e.g. after /reload pi calls the default export again
  assert.equal(handlers.agent_settled.length, 2);
});
