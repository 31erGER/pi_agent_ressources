/**
 * efforts.test.mjs — unit tests for projects/lmstudio/lmstudio-efforts.ts
 *
 * Run: node /home/julian/.pi/agent/projects/lmstudio/efforts.test.mjs
 *
 * Covers (see PLAN.md acceptance criteria 1):
 *  - loadEfforts: missing file, valid file (sanitization), corrupt JSON (backup rename),
 *    valid-JSON-but-not-an-object (backup rename)
 *  - ensureModels: auto-create default entry for every unknown model id, preserve user
 *    edits, keep stale entries, idempotent (no rewrite when unchanged), preserve
 *    user formatting when nothing to add
 *  - entryToThinkingLevelMap: full / partial / empty entries
 *  - DEFAULT_ENTRY pinned values, effortsFileUrl default + env override
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PI_LEVELS,
  DEFAULT_ENTRY,
  effortsFileUrl,
  loadEfforts,
  ensureModels,
  entryToThinkingLevelMap,
} from "./lmstudio-efforts.ts";

async function tempFile(name = "efforts.json") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lmstudio-efforts-"));
  const url = new URL(`file://${path.join(dir, name)}`);
  return { dir, url };
}

// ---------------------------------------------------------------- loadEfforts

test("loadEfforts: missing file -> {}", async () => {
  const { url } = await tempFile();
  await assert.deepEqual(await loadEfforts(url), {});
});

test("loadEfforts: valid file is parsed and sanitized", async () => {
  const { url } = await tempFile();
  await fs.writeFile(
    url.pathname,
    JSON.stringify({
      "m/one": { off: "none", high: "high", bogusLevel: "high", max: "", empty: "   " },
      "m/two": { medium: null, low: 42 },
      "": { off: "none" }, // empty model id dropped
    }),
  );
  const data = await loadEfforts(url);
  assert.deepEqual(Object.keys(data).sort(), ["m/one", "m/two"]);
  // unknown level keys dropped, empty/whitespace strings dropped, non-strings dropped, null kept
  assert.deepEqual(data["m/one"], { off: "none", high: "high" });
  assert.deepEqual(data["m/two"], { medium: null });
});

test("loadEfforts: corrupt JSON -> renamed to .corrupt-*, result {}", async () => {
  const { dir, url } = await tempFile();
  await fs.writeFile(url.pathname, "{ not json");
  const data = await loadEfforts(url);
  assert.deepEqual(data, {});
  const entries = await fs.readdir(dir);
  assert.equal(entries.includes("efforts.json"), false, "original must be gone");
  assert.ok(
    entries.some((e) => /^efforts\.json\.corrupt-/.test(e)),
    `expected a .corrupt- backup, got: ${entries.join(", ")}`,
  );
});

test("loadEfforts: valid JSON but not an object -> treated as corrupt", async () => {
  const { dir, url } = await tempFile();
  await fs.writeFile(url.pathname, "[1, 2, 3]");
  const data = await loadEfforts(url);
  assert.deepEqual(data, {});
  const entries = await fs.readdir(dir);
  assert.ok(entries.some((e) => /^efforts\.json\.corrupt-/.test(e)));
});

// --------------------------------------------------------------- ensureModels

test("ensureModels: creates dir+file with default entry for every unknown model", async () => {
  const { dir, url } = await tempFile("nested/sub/efforts.json");
  const data = await ensureModels(url, ["a/first", "b/second"]);
  assert.deepEqual(data, {
    "a/first": { ...DEFAULT_ENTRY },
    "b/second": { ...DEFAULT_ENTRY },
  });
  const raw = await fs.readFile(url.pathname, "utf8");
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, data);
  // canonical formatting: 2-space indent + trailing newline
  assert.equal(raw, JSON.stringify(parsed, null, 2) + "\n");
  assert.ok((await fs.stat(path.join(dir, "nested/sub"))).isDirectory());
});

test("ensureModels: preserves user edits and only adds missing ids", async () => {
  const { url } = await tempFile();
  await fs.writeFile(
    url.pathname,
    JSON.stringify({ "m/one": { off: "none", high: "xhigh" } }) + "\n",
  );
  const data = await ensureModels(url, ["m/one", "m/new"]);
  // user value untouched (high: "xhigh" is NOT reset to default)
  assert.equal(data["m/one"].high, "xhigh");
  assert.equal(data["m/one"].off, "none");
  // missing levels in an existing entry are backfilled from DEFAULT_ENTRY (entries are always complete;
  // to disable a level the user must set it to null explicitly)
  assert.equal(data["m/one"].max, DEFAULT_ENTRY.max);
  assert.equal(data["m/one"].low, DEFAULT_ENTRY.low);
  assert.deepEqual(data["m/new"], { ...DEFAULT_ENTRY });
});

test("ensureModels: keeps stale entries for models no longer in the catalog", async () => {
  const { url } = await tempFile();
  await fs.writeFile(
    url.pathname,
    JSON.stringify({ "m/gone": { off: "none" }, "m/still": { off: "none" } }) + "\n",
  );
  const data = await ensureModels(url, ["m/still"]);
  assert.ok("m/gone" in data, "stale entry must be preserved");
  assert.ok("m/still" in data);
});

test("ensureModels: idempotent — no rewrite when nothing to add", async () => {
  const { url } = await tempFile();
  await ensureModels(url, ["m/one"]);
  const before = await fs.readFile(url.pathname, "utf8");
  const after = await ensureModels(url, ["m/one"]);
  const afterRaw = await fs.readFile(url.pathname, "utf8");
  assert.equal(afterRaw, before, "file must be byte-identical");
  assert.deepEqual(after, JSON.parse(before));
});

test("ensureModels: preserves user formatting when entry already complete", async () => {
  const { url } = await tempFile();
  // complete 7-level entry, user's 4-space style: nothing to add/backfill -> no rewrite
  const fancy =
    '{\n    "m/one": {\n      "off": "none",\n      "minimal": "minimal",\n      "low": "low",\n      "medium": "medium",\n      "high": "high",\n      "xhigh": "xhigh",\n      "max": "xhigh"\n    }\n  }\n';
  await fs.writeFile(url.pathname, fancy);
  await ensureModels(url, ["m/one"]);
  assert.equal(await fs.readFile(url.pathname, "utf8"), fancy, "must not reformat untouched file");
});

test("ensureModels: rewrites (canonical) when an entry IS added", async () => {
  const { url } = await tempFile();
  const fancy = '{\n    "m/one": { "off": "none" }\n}\n';
  await fs.writeFile(url.pathname, fancy);
  await ensureModels(url, ["m/one", "m/two"]);
  const raw = await fs.readFile(url.pathname, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(raw, JSON.stringify(parsed, null, 2) + "\n", "rewrite must be canonical");
  assert.deepEqual(parsed["m/two"], { ...DEFAULT_ENTRY });
  assert.equal(parsed["m/one"].off, "none", "existing entry content preserved");
});

// ---------------------------------------------------- entryToThinkingLevelMap

test("entryToThinkingLevelMap: full entry maps all seven levels", () => {
  const map = entryToThinkingLevelMap({
    off: "none", minimal: "minimal", low: "low", medium: "medium",
    high: "high", xhigh: "xhigh", max: "xhigh",
  });
  assert.deepEqual(map, {
    off: "none", minimal: "minimal", low: "low", medium: "medium",
    high: "high", xhigh: "xhigh", max: "xhigh",
  });
});

test("entryToThinkingLevelMap: partial entry -> missing levels are null", () => {
  const map = entryToThinkingLevelMap({ off: "none", high: "high" });
  assert.deepEqual(map, {
    off: "none", minimal: null, low: null, medium: null,
    high: "high", xhigh: null, max: null,
  });
});

test("entryToThinkingLevelMap: undefined/empty entry -> all null", () => {
  assert.deepEqual(entryToThinkingLevelMap(undefined), {
    off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
  });
  assert.deepEqual(entryToThinkingLevelMap({}), {
    off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
  });
});

// ------------------------------------------------- constants + effortsFileUrl

test("PI_LEVELS is exactly the seven pi levels", () => {
  assert.deepEqual(PI_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("DEFAULT_ENTRY pinned (LM Studio supported values, verified live 2026-11-04)", () => {
  assert.deepEqual(DEFAULT_ENTRY, {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "xhigh",
  });
});

test("effortsFileUrl: no-arg default resolves next to this module (projects/lmstudio)", () => {
  const url = effortsFileUrl();
  assert.ok(
    url.pathname.endsWith("projects/lmstudio/efforts.json"),
    `unexpected default: ${url.pathname}`,
  );
});

test("effortsFileUrl: extension-provided URL resolves ../projects/lmstudio/efforts.json", () => {
  const url = effortsFileUrl("file:///home/julian/.pi/agent/extensions/lmstudio.ts");
  assert.equal(url.pathname, "/home/julian/.pi/agent/projects/lmstudio/efforts.json");
});

test("effortsFileUrl: honors LM_STUDIO_EFFORTS_FILE override", () => {
  const prev = process.env.LM_STUDIO_EFFORTS_FILE;
  process.env.LM_STUDIO_EFFORTS_FILE = "/tmp/some/other/efforts.json";
  try {
    assert.equal(effortsFileUrl().pathname, "/tmp/some/other/efforts.json");
  } finally {
    if (prev === undefined) delete process.env.LM_STUDIO_EFFORTS_FILE;
    else process.env.LM_STUDIO_EFFORTS_FILE = prev;
  }
});
