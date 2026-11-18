// history-view.test.ts — TDD-first unit tests for src/history-view.ts
//
// Pure node:test suite. No pi imports. Runs on Node 26 type-stripping.

import { test } from "node:test";
import assert from "node:assert";
import { buildHistoryLines, formatEntry, clampScroll } from "../src/history-view.ts";

// ──────────────────────────────────────────────
// Structural types matching session JSONL shapes
// ──────────────────────────────────────────────
interface PlainEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

interface PlainMessageEntry extends PlainEntry {
  type: "message";
  message: {
    role: string;
    content: unknown;
    isError?: boolean;
  };
}

interface PlainCompactionEntry extends PlainEntry {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

interface PlainBranchSummaryEntry extends PlainEntry {
  type: "branch_summary";
  fromId: string;
  summary: string;
}

interface PlainCustomEntry extends PlainEntry {
  type: "custom";
  customType: string;
  data?: unknown;
}

interface PlainUsageEntry extends PlainEntry {
  type: "usage";
  kind: string;
}

interface PlainCustomMessageEntry extends PlainEntry {
  type: "custom_message";
  customType: string;
  content: string;
  display: boolean;
}

type TestEntry =
  | PlainMessageEntry
  | PlainCompactionEntry
  | PlainBranchSummaryEntry
  | PlainCustomEntry
  | PlainUsageEntry
  | PlainCustomMessageEntry;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function msg(id: string, role: string, content: unknown, isError?: boolean): PlainMessageEntry {
  const m: PlainMessageEntry = { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role, content } };
  if (isError !== undefined) m.message.isError = isError;
  return m;
}

function compaction(id: string, summary: string, firstKeptId: string): PlainCompactionEntry {
  return { type: "compaction", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", summary, firstKeptEntryId: firstKeptId, tokensBefore: 50000 };
}

// ──────────────────────────────────────────────
// Format rules under test:
//   - every rendered entry's FIRST line is prefixed with its UTC "HH:MM" timestamp
//   - user entries:      "HH:MM You: <first text line>" (accent), continuation lines plain
//   - assistant entries: "HH:MM Assistant: <first text line>" if the entry starts with text,
//                        otherwise "HH:MM ⚒ tool: <name>" (dim); other lines unprefixed
//   - toolResult:        "HH:MM ↳ ok · N lines" (dim) / "HH:MM ↳ error · N lines" (error),
//                        singular "1 line"
//   - compaction:        "HH:MM ⧉ Compaction: <summary>" (warning)
//   - branch_summary:    "HH:MM ⧉ Branch Summary: <summary>" (warning)
//   - one blank line between rendered entries; skipped entries emit nothing
// ──────────────────────────────────────────────

test("buildHistoryLines — full view: chronological with timestamp, blank line, Assistant label", () => {
  const entries: TestEntry[] = [
    msg("m1", "user", "hello"),
    msg("m2", "assistant", "hi there"),
  ];
  const lines = buildHistoryLines(entries, "full");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["00:00 You: hello", "", "00:00 Assistant: hi there"],
  );
  assert.equal(lines[0].color, "accent");
});

test("buildHistoryLines — user message: continuation lines are plain, no prefix", () => {
  const entries: TestEntry[] = [msg("m1", "user", "line one\nline two")];
  const lines = buildHistoryLines(entries, "full");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["00:00 You: line one", "line two"],
  );
  assert.equal(lines[1].color, undefined);
});

test("buildHistoryLines — full view: toolCall → ⚒ tool: <name> (dim), entry starts with text", () => {
  const entries: TestEntry[] = [
    msg("m1", "user", "run ls"),
    msg("m2", "assistant", [
      { type: "text", text: "Let me run that." },
      { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
    ]),
  ];
  const lines = buildHistoryLines(entries, "full");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["00:00 You: run ls", "", "00:00 Assistant: Let me run that.", "⚒ tool: bash"],
  );
  const tool = lines.find((l) => l.text === "⚒ tool: bash");
  assert.equal(tool?.color, "dim");
});

test("buildHistoryLines — assistant entry starting with toolCall: no Assistant label", () => {
  const entries: TestEntry[] = [
    msg("m1", "assistant", [
      { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
      { type: "text", text: "done" },
    ]),
  ];
  const lines = buildHistoryLines(entries, "full");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["00:00 ⚒ tool: bash", "done"],
  );
});

test("buildHistoryLines — full view: toolResult → ↳ ok · N lines (dim)", () => {
  const entries: TestEntry[] = [
    msg("m1", "user", "run ls"),
    msg("m2", "assistant", [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }]),
    msg("m3", "toolResult", [{ type: "text", text: "file1\nfile2\nfile3" }]),
  ];
  const lines = buildHistoryLines(entries, "full");
  const res = lines.find((l) => l.text === "00:00 ↳ ok · 3 lines");
  assert.ok(res, `expected tool result line, got: ${JSON.stringify(lines.map((l) => l.text))}`);
  assert.equal(res?.color, "dim");
});

test("buildHistoryLines — full view: toolResult error → ↳ error · N lines, singular line", () => {
  const entries: TestEntry[] = [
    msg("m1", "user", "bad command"),
    msg("m2", "assistant", [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }]),
    msg("m3", "toolResult", [{ type: "text", text: "bash: bad: command not found" }], true),
  ];
  const lines = buildHistoryLines(entries, "full");
  const res = lines.find((l) => l.text === "00:00 ↳ error · 1 line");
  assert.ok(res, `expected tool result line, got: ${JSON.stringify(lines.map((l) => l.text))}`);
  assert.equal(res?.color, "error");
});

test("buildHistoryLines — context view: compaction entry → ⧉ Compaction: <summary> (warning)", () => {
  const entries: TestEntry[] = [
    compaction("c1", "User asked about auth", "m3"),
    msg("m3", "user", "later message"),
  ];
  const lines = buildHistoryLines(entries, "context");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["00:00 ⧉ Compaction: User asked about auth", "", "00:00 You: later message"],
  );
  assert.equal(lines[0].color, "warning");
});

test("buildHistoryLines — context view: pre-compaction messages absent", () => {
  const entries: TestEntry[] = [
    compaction("c1", "Summary here", "m3"),
    msg("m3", "user", "retained"),
    msg("m4", "assistant", "still here"),
  ];
  const lines = buildHistoryLines(entries, "context");
  const text = lines.map((l) => l.text).join("\n");
  assert.ok(!text.includes("before compaction"));
  assert.ok(text.includes("retained"));
  assert.ok(text.includes("still here"));
});

test("buildHistoryLines — context view: system/usage/custom/custom_message entries skipped (no stray blanks)", () => {
  const entries: TestEntry[] = [
    msg("m1", "system", "prompt"),
    msg("m2", "user", "hello"),
    { type: "usage", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", kind: "cache_warm" } as PlainUsageEntry,
    { type: "custom", id: "cu1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "my-ext", data: {} } as PlainCustomEntry,
    { type: "custom_message", id: "cm1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "my-ext", content: "injected", display: true } as PlainCustomMessageEntry,
  ];
  const lines = buildHistoryLines(entries, "context");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["00:00 You: hello"],
  );
});

test("buildHistoryLines — empty branch → single hint line", () => {
  const lines = buildHistoryLines([], "full");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].text.includes("No messages"));
});

test("buildHistoryLines — branch_summary entry → ⧉ Branch Summary: <summary> (warning)", () => {
  const entries: TestEntry[] = [
    { type: "branch_summary", id: "bs1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", fromId: "old1", summary: "Abandoned path" } as PlainBranchSummaryEntry,
    msg("m1", "user", "new path"),
  ];
  const lines = buildHistoryLines(entries, "full");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["00:00 ⧉ Branch Summary: Abandoned path", "", "00:00 You: new path"],
  );
  assert.equal(lines[0].color, "warning");
});

test("buildHistoryLines — multiple compactions: only latest compaction marker shown (full)", () => {
  const entries: TestEntry[] = [
    compaction("c1", "old summary", "m3"),
    msg("m3", "user", "between"),
    compaction("c2", "new summary", "m5"),
    msg("m5", "user", "after"),
  ];
  const lines = buildHistoryLines(entries, "full");
  const text = lines.map((l) => l.text).join("\n");
  assert.ok(text.includes("new summary"));
  assert.ok(!text.includes("old summary")); // old compaction hidden
  assert.ok(text.includes("after"));
  assert.ok(text.includes("between")); // entries between compactions are real history
  assert.equal((text.match(/⧉ Compaction:/g) || []).length, 1);
});

test("buildHistoryLines — assistant with only text content", () => {
  const entries: TestEntry[] = [
    msg("m1", "assistant", [{ type: "text", text: "response text" }]),
  ];
  const lines = buildHistoryLines(entries, "full");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["00:00 Assistant: response text"],
  );
});

test("buildHistoryLines — assistant thinking block skipped", () => {
  const entries: TestEntry[] = [
    msg("m1", "assistant", [
      { type: "thinking", text: "thinking..." },
      { type: "text", text: "final answer" },
    ]),
  ];
  const lines = buildHistoryLines(entries, "full");
  const text = lines.map((l) => l.text).join("\n");
  assert.ok(!text.includes("thinking"));
  assert.ok(text.includes("00:00 Assistant: final answer"));
});

test("formatEntry — toolResult with multi-line string content counts lines", () => {
  const lines = formatEntry(msg("m1", "toolResult", "a\nb\nc"), "full");
  assert.deepEqual(lines.map((l) => l.text), ["00:00 ↳ ok · 3 lines"]);
});

// ──────────────────────────────────────────────
// clampScroll tests
// ──────────────────────────────────────────────

test("clampScroll — clamps to valid range", () => {
  assert.equal(clampScroll(-5, 0, 100, 20), 0);
  assert.equal(clampScroll(105, 0, 100, 20), 80);
  assert.equal(clampScroll(10, 0, 100, 20), 10);
});

test("clampScroll — scroll down", () => {
  assert.equal(clampScroll(0, 10, 100, 20), 10);
});

test("clampScroll — scroll up", () => {
  assert.equal(clampScroll(20, -10, 100, 20), 10);
});

test("clampScroll — negative content height → 0", () => {
  assert.equal(clampScroll(0, 5, 0, 20), 0);
  assert.equal(clampScroll(0, 5, 100, 0), 0);
});
