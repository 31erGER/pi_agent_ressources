/**
 * dynamic-efforts.test.mjs — unit tests for projects/dynamic-readoning-levels/dynamic-efforts.ts
 *
 * Run: node /home/julian/.pi/agent/projects/dynamic-readoning-levels/dynamic-efforts.test.mjs
 *
 * Covers the pure-module contract (PLAN.md step 1, TDD RED):
 *  - parseLevelsArg: comma/space separated, case-insensitive, deduped, canonical order,
 *    null on empty/unknown tokens
 *  - applyEffortArray: full 7-key ModelEntry; listed levels keep existing value or
 *    DEFAULT_ENTRY value, unlisted -> null
 *  - levelsFromModel: exact mirror of pi-ai getSupportedThinkingLevels semantics
 *    (non-reasoning -> ["off"]; null hides any level; xhigh/max need explicit mapping)
 *  - optionsDiffer: compares the derived available-level SETS (semantically equal maps
 *    with different representations must not differ)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PI_LEVELS, DEFAULT_ENTRY } from "../lmstudio/lmstudio-efforts.ts";
import {
  parseLevelsArg,
  applyEffortArray,
  levelsFromModel,
  optionsDiffer,
} from "./dynamic-efforts.ts";

// ------------------------------------------------------------- parseLevelsArg

test("parseLevelsArg: comma list, canonical order", () => {
  assert.deepEqual(parseLevelsArg("high,off,xhigh,low"), ["off", "low", "high", "xhigh"]);
});

test("parseLevelsArg: trims whitespace and is case-insensitive", () => {
  assert.deepEqual(parseLevelsArg("  High , off, LOW"), ["off", "low", "high"]);
});

test("parseLevelsArg: space-separated tokens accepted", () => {
  assert.deepEqual(parseLevelsArg("off low high"), ["off", "low", "high"]);
});

test("parseLevelsArg: duplicates removed", () => {
  assert.deepEqual(parseLevelsArg("high,high,off"), ["off", "high"]);
});

test("parseLevelsArg: all seven levels round-trip", () => {
  assert.deepEqual(parseLevelsArg(PI_LEVELS.join(",")), [...PI_LEVELS]);
});

test("parseLevelsArg: empty or whitespace-only -> null", () => {
  assert.equal(parseLevelsArg(""), null);
  assert.equal(parseLevelsArg("   "), null);
});

test("parseLevelsArg: unknown token -> null (even mixed with valid ones)", () => {
  assert.equal(parseLevelsArg("off,ultra"), null);
  assert.equal(parseLevelsArg("bogus"), null);
});

// ----------------------------------------------------------- applyEffortArray

test("applyEffortArray: no entry -> listed levels get DEFAULT_ENTRY values, rest null", () => {
  const entry = applyEffortArray(undefined, ["off", "high"]);
  assert.deepEqual(entry, {
    off: "none", // DEFAULT_ENTRY.off
    minimal: null,
    low: null,
    medium: null,
    high: "high", // DEFAULT_ENTRY.high
    xhigh: null,
    max: null,
  });
});

test("applyEffortArray: existing user values win over defaults", () => {
  const prev = { high: "ultra-custom", max: "xhigh-custom" };
  const entry = applyEffortArray(prev, ["high", "max"]);
  assert.equal(entry.high, "ultra-custom");
  assert.equal(entry.max, "xhigh-custom");
  assert.equal(entry.off, null);
});

test("applyEffortArray: missing listed level backfilled from DEFAULT_ENTRY", () => {
  const entry = applyEffortArray({}, ["low", "max"]);
  assert.equal(entry.low, "low"); // DEFAULT_ENTRY.low
  assert.equal(entry.max, "xhigh"); // DEFAULT_ENTRY.max
  assert.equal(entry.minimal, null);
});

test("applyEffortArray: explicit null / blank listed level falls back to DEFAULT_ENTRY", () => {
  assert.equal(applyEffortArray({ low: null }, ["low"]).low, "low");
  assert.equal(applyEffortArray({ low: " " }, ["low"]).low, "low");
});

test("applyEffortArray: result always has exactly the seven PI_LEVELS keys", () => {
  for (const levels of [[], ["off"], [...PI_LEVELS]]) {
    assert.deepEqual(Object.keys(applyEffortArray(undefined, levels)).sort(), [...PI_LEVELS].sort());
  }
});

test("applyEffortArray: full list reproduces DEFAULT_ENTRY", () => {
  assert.deepEqual(applyEffortArray(undefined, [...PI_LEVELS]), { ...DEFAULT_ENTRY });
});

test("applyEffortArray: empty list disables every level", () => {
  const entry = applyEffortArray(DEFAULT_ENTRY, []);
  for (const level of PI_LEVELS) assert.equal(entry[level], null);
});

// ------------------------------------------------------------ levelsFromModel
// Semantics mirror pi-ai/dist/models.js getSupportedThinkingLevels (verified 1.5.0):
//   !reasoning -> ["off"]
//   null map entry -> level hidden (any level)
//   xhigh/max -> only when explicitly mapped (non-null)
//   off/minimal/low/medium/high -> available by default for reasoning models

test("levelsFromModel: non-reasoning model exposes only off", () => {
  assert.deepEqual(levelsFromModel({ reasoning: false }), ["off"]);
  assert.deepEqual(levelsFromModel({}), ["off"]);
});

test("levelsFromModel: reasoning model without map gets the five base levels", () => {
  assert.deepEqual(levelsFromModel({ reasoning: true }), [
    "off", "minimal", "low", "medium", "high",
  ]);
});

test("levelsFromModel: xhigh/max appear only when explicitly mapped", () => {
  assert.deepEqual(
    levelsFromModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    ["off", "minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    levelsFromModel({ reasoning: true, thinkingLevelMap: { max: "xhigh" } }),
    ["off", "minimal", "low", "medium", "high", "max"],
  );
});

test("levelsFromModel: null hides any level, including base levels", () => {
  assert.deepEqual(
    levelsFromModel({ reasoning: true, thinkingLevelMap: { high: null } }),
    ["off", "minimal", "low", "medium"],
  );
  assert.deepEqual(
    levelsFromModel({ reasoning: true, thinkingLevelMap: { off: null, xhigh: "x", max: "x" } }),
    ["minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

// ------------------------------------------------------------- optionsDiffer

test("optionsDiffer: identical sets -> false (values irrelevant)", () => {
  assert.equal(
    optionsDiffer(
      { reasoning: true, thinkingLevelMap: { high: "a" } },
      { reasoning: true, thinkingLevelMap: { high: "b" } },
    ),
    false,
  );
});

test("optionsDiffer: different sets -> true", () => {
  assert.equal(
    optionsDiffer(
      { reasoning: true, thinkingLevelMap: {} },
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    ),
    true,
  );
});

test("optionsDiffer: semantically equal maps (undefined vs null xhigh) -> false", () => {
  assert.equal(
    optionsDiffer(
      { reasoning: true, thinkingLevelMap: { high: "a" } },
      { reasoning: true, thinkingLevelMap: { high: "b", xhigh: null } },
    ),
    false,
  );
});

test("optionsDiffer: reasoning flag flip -> true", () => {
  assert.equal(
    optionsDiffer({ reasoning: true, thinkingLevelMap: {} }, { reasoning: false }),
    true,
  );
});

test("optionsDiffer: applyEffortArray round-trip (set changed vs unchanged)", () => {
  const prev = applyEffortArray(undefined, [...PI_LEVELS]); // full defaults
  const narrowed = applyEffortArray(prev, ["off", "high"]);
  const before = { reasoning: true, thinkingLevelMap: prev };
  const after = { reasoning: true, thinkingLevelMap: narrowed };
  assert.equal(optionsDiffer(before, after), true);
  // Re-applying the same array yields identical options -> no spurious setModel.
  const again = applyEffortArray(narrowed, ["off", "high"]);
  assert.equal(optionsDiffer(after, { reasoning: true, thinkingLevelMap: again }), false);
});
