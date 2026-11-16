/**
 * token-ledger.test.ts — unit + wiring tests for the generation-time token ledger.
 *
 * Run:
 *   cd /home/julian/.pi/agent/projects/token-counter && node --test test/
 *
 * Hermetic: each test points PI_CODING_AGENT_DIR at a fresh mkdtemp agent dir
 * (pi's getAgentDir() honors that env var — verified in pi's dist/config.js).
 * The real agent dir is never touched.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendUsage,
  ledgerPath,
  seedIfNeeded,
  sumLedger,
  sumSessionFile,
  sumSessionFiles,
} from "../../../extensions/token-counter-ledger/ledger.ts";
import extension from "../../../extensions/token-counter.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Expected sum of SESSION_FIXTURE:
 *   m2 assistant        i=100 o=50
 *   m3 assistant        i=7   o=3
 *   c1 compaction       i=10  o=5
 *   b1 branch_summary   i=3   o=2
 *   u1 usage entry      i=1   o=1
 *   m4 assistant (last line, NO trailing newline) i=4 o=2
 *   -> input 125, output 63
 * Also contains: a user message (no usage, ignored), a custom entry without
 * "usage" (fast-path skipped) and a non-JSON line that mentions "usage"
 * (parse failure, skipped).
 */
const SESSION_FIXTURE = [
  '{"type":"session","id":"s1","parentId":null,"timestamp":"2026-11-01T00:00:00.000Z","cwd":"/x","path":"/x"}',
  '{"type":"message","id":"m1","parentId":"s1","timestamp":"2026-11-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
  '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-11-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"api":"openai-completions","provider":"lmstudio","model":"qwen3","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","errorMessage":""}}',
  '{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-11-01T00:00:03.000Z","message":{"role":"assistant","content":[],"api":"openai-completions","provider":"lmstudio","model":"qwen3","usage":{"input":7,"output":3,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","errorMessage":""}}',
  '{"type":"compaction","id":"c1","parentId":"m3","timestamp":"2026-11-01T00:00:04.000Z","summary":"s","firstKeptEntryId":"m3","tokensBefore":10,"durationMs":5,"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
  '{"type":"branch_summary","id":"b1","parentId":"m3","fromId":"m2","timestamp":"2026-11-01T00:00:05.000Z","summary":"b","usage":{"input":3,"output":2,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
  '{"type":"usage","id":"u1","parentId":"b1","timestamp":"2026-11-01T00:00:06.000Z","kind":"cache_warm","provider":"p","model":"m","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
  '{"type":"custom","id":"n1","parentId":"u1","timestamp":"2026-11-01T00:00:07.000Z","customType":"note","data":{"a":1}}',
  'this line is not json but mentions "usage"',
  '{"type":"message","id":"m4","parentId":"n1","timestamp":"2026-11-01T00:00:08.000Z","message":{"role":"assistant","content":[],"api":"openai-completions","provider":"lmstudio","model":"qwen3","usage":{"input":4,"output":2,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","errorMessage":""}}',
].join("\n"); // deliberately no trailing newline

/** Nuked-session fixture (discarded-sessions/): input 5, output 2. */
const OLD_SESSION_FIXTURE = [
  '{"type":"session","id":"os1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","cwd":"/x","path":"/x"}',
  '{"type":"message","id":"om1","parentId":"os1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[],"api":"openai-completions","provider":"lmstudio","model":"qwen3","usage":{"input":5,"output":2,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","errorMessage":""}}',
].join("\n") + "\n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let root: string;
let counter = 0;

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "tok-ledger-test-"));
});

after(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** Fresh temp agent dir (with sessions/<slug>/ + discarded-sessions/), env pointed at it. */
async function makeAgentDir(): Promise<string> {
  const dir = path.join(root, `agent-${++counter}`);
  await fsp.mkdir(path.join(dir, "sessions", "slug"), { recursive: true });
  await fsp.mkdir(path.join(dir, "discarded-sessions"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

async function writeSession(dir: string, fixture: string = SESSION_FIXTURE): Promise<string> {
  const file = path.join(dir, "sessions", "slug", "2026-01-01T00-00-00_00000000-0000-4000-8000-000000000000.jsonl");
  await fsp.writeFile(file, fixture, "utf8");
  return file;
}

async function readLedgerLines(dir: string): Promise<any[]> {
  const raw = await fsp.readFile(ledgerPath(dir), "utf8");
  return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Unit: ledger module
// ---------------------------------------------------------------------------

test("sumSessionFile: whole-file sum incl. compaction/branch/usage entries; skips garbage", async () => {
  const dir = await makeAgentDir();
  const file = await writeSession(dir);
  assert.deepEqual(await sumSessionFile(file), { input: 125, output: 63 });
});

test("sumSessionFile: rejects for a missing file", async () => {
  await makeAgentDir();
  await assert.rejects(() => sumSessionFile(path.join(root, "does-not-exist.jsonl")));
});

test("sumSessionFiles: totals across sessions/ and discarded-sessions/", async () => {
  const dir = await makeAgentDir();
  await writeSession(dir);
  await fsp.writeFile(path.join(dir, "discarded-sessions", "old.jsonl"), OLD_SESSION_FIXTURE, "utf8");
  const totals = await sumSessionFiles([path.join(dir, "sessions"), path.join(dir, "discarded-sessions")]);
  assert.equal(totals.input, 130);
  assert.equal(totals.output, 65);
  assert.equal(totals.files, 2);
});

test("appendUsage + sumLedger: round-trip with model tag and kind", async () => {
  const dir = await makeAgentDir();
  await appendUsage({ input: 10, output: 5, model: "lmstudio/qwen3" }, dir);
  await appendUsage({ input: 1, output: 2, kind: "compact" }, dir);
  assert.deepEqual(await sumLedger(dir), { input: 11, output: 7 });
  const lines = await readLedgerLines(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].m, "lmstudio/qwen3");
  assert.equal(lines[0].i, 10);
  assert.equal(lines[0].o, 5);
  assert.ok(lines[0].t); // ISO timestamp present
  assert.equal(lines[1].kind, "compact");
});

test("appendUsage: all-zero usage writes nothing", async () => {
  const dir = await makeAgentDir();
  await appendUsage({ input: 0, output: 0 }, dir);
  await assert.rejects(() => fsp.stat(ledgerPath(dir)));
});

test("sumLedger: skips corrupt lines and picks up later appends", async () => {
  const dir = await makeAgentDir();
  await appendUsage({ input: 10, output: 5 }, dir);
  await fsp.appendFile(ledgerPath(dir), "garbage-not-json\n", "utf8");
  assert.deepEqual(await sumLedger(dir), { input: 10, output: 5 });
  await appendUsage({ input: 1, output: 1 }, dir);
  assert.deepEqual(await sumLedger(dir), { input: 11, output: 6 });
});

test("sumLedger: missing ledger file yields zero", async () => {
  const dir = await makeAgentDir();
  assert.deepEqual(await sumLedger(dir), { input: 0, output: 0 });
});

test("seedIfNeeded: one seed line covering sessions/ + discarded-sessions/, lock cleaned up", async () => {
  const dir = await makeAgentDir();
  await writeSession(dir);
  await fsp.writeFile(path.join(dir, "discarded-sessions", "old.jsonl"), OLD_SESSION_FIXTURE, "utf8");
  assert.equal(await seedIfNeeded(dir), "seeded");
  const lines = await readLedgerLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].seed, true);
  assert.equal(lines[0].i, 130);
  assert.equal(lines[0].o, 65);
  assert.equal(lines[0].files, 2);
  await assert.rejects(() => fsp.stat(path.join(dir, ".token-ledger.lock")));
});

test("seedIfNeeded: idempotent — second call does not re-seed", async () => {
  const dir = await makeAgentDir();
  await writeSession(dir);
  await seedIfNeeded(dir);
  assert.equal(await seedIfNeeded(dir), "already");
  assert.equal((await readLedgerLines(dir)).length, 1);
});

// ---------------------------------------------------------------------------
// Wiring: token-counter.ts extension (fake pi API)
// ---------------------------------------------------------------------------

function fakePi() {
  const handlers: Record<string, (event: any, ctx: any) => Promise<void>> = {};
  const commands: Record<string, unknown> = {};
  const api = {
    on: (name: string, h: (event: any, ctx: any) => Promise<void>) => {
      handlers[name] = h;
    },
    registerCommand: (name: string, def: unknown) => {
      commands[name] = def;
    },
  };
  return { handlers, commands, api };
}

function fakeCtx(mode: string = "tui"): any {
  return {
    mode,
    ui: {
      theme: { fg: (_color: string, s: string) => s },
      setStatus: () => undefined,
      notify: () => undefined,
    },
  };
}

function assistantMessage(input: number, output: number): any {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "lmstudio",
    model: "qwen3",
    content: [],
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    errorMessage: "",
  };
}

async function runExtension(): Promise<ReturnType<typeof fakePi>> {
  const fake = fakePi();
  extension(fake.api as Parameters<typeof extension>[0]);
  return fake;
}

test("wiring: session_start seeds the ledger exactly once (awaited, before first turn)", async () => {
  const dir = await makeAgentDir();
  await writeSession(dir);
  const fake = await runExtension();
  await fake.handlers.session_start({}, fakeCtx());
  const seeds = (await readLedgerLines(dir)).filter((l) => l.seed === true);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].i, 125);
  assert.equal(seeds[0].o, 63);
  assert.equal(seeds[0].files, 1);

  // Second start (e.g. session switch) must not re-seed.
  await fake.handlers.session_start({}, fakeCtx());
  assert.equal((await readLedgerLines(dir)).filter((l) => l.seed === true).length, 1);

  await fake.handlers.session_shutdown({}, fakeCtx());
});

test("wiring: turn_end records the assistant usage with the model tag", async () => {
  const dir = await makeAgentDir();
  const fake = await runExtension();
  await fake.handlers.session_start({}, fakeCtx());
  await fake.handlers.turn_end(
    { type: "turn_end", turnIndex: 0, message: assistantMessage(12, 34) },
    fakeCtx(),
  );
  const lines = await readLedgerLines(dir);
  const turn = lines.find((l) => l.m === "lmstudio/qwen3");
  assert.ok(turn, "turn line with model tag expected");
  assert.equal(turn.i, 12);
  assert.equal(turn.o, 34);
  await fake.handlers.session_shutdown({}, fakeCtx());
});

test("wiring: turn_end ignores non-assistant messages", async () => {
  const dir = await makeAgentDir();
  const fake = await runExtension();
  await fake.handlers.session_start({}, fakeCtx());
  const before = (await readLedgerLines(dir)).length;
  await fake.handlers.turn_end(
    { type: "turn_end", turnIndex: 0, message: { role: "user", content: [] } },
    fakeCtx(),
  );
  assert.equal((await readLedgerLines(dir)).length, before);
  await fake.handlers.session_shutdown({}, fakeCtx());
});

test("wiring: session_compact records the summary call usage", async () => {
  const dir = await makeAgentDir();
  const fake = await runExtension();
  await fake.handlers.session_start({}, fakeCtx());
  await fake.handlers.session_compact(
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { type: "compaction", usage: { input: 5, output: 2 } },
      fromExtension: false,
    },
    fakeCtx(),
  );
  const compact = (await readLedgerLines(dir)).find((l) => l.kind === "compact");
  assert.ok(compact, "compact line expected");
  assert.equal(compact.i, 5);
  assert.equal(compact.o, 2);
  await fake.handlers.session_shutdown({}, fakeCtx());
});

test("wiring: session_tree records branch summary usage; no line without summaryEntry", async () => {
  const dir = await makeAgentDir();
  const fake = await runExtension();
  await fake.handlers.session_start({}, fakeCtx());
  await fake.handlers.session_tree(
    { type: "session_tree", oldLeafId: "a", newLeafId: "b", summaryEntry: { type: "branch_summary", usage: { input: 1, output: 1 } } },
    fakeCtx(),
  );
  const branch = (await readLedgerLines(dir)).find((l) => l.kind === "branch");
  assert.ok(branch, "branch line expected");
  assert.equal(branch.i, 1);
  assert.equal(branch.o, 1);

  const before = (await readLedgerLines(dir)).length;
  await fake.handlers.session_tree({ type: "session_tree", oldLeafId: "a", newLeafId: "b" }, fakeCtx());
  assert.equal((await readLedgerLines(dir)).length, before, "navigation without summary must not record");
  await fake.handlers.session_shutdown({}, fakeCtx());
});

test("wiring: command registered; non-tui mode still records but does not seed UI", async () => {
  const dir = await makeAgentDir();
  const fake = await runExtension();
  assert.ok(fake.commands["token-counter"], "/token-counter command expected");

  await fake.handlers.session_start({}, fakeCtx("rpc"));
  // Seeding is a data migration: it must happen in all modes.
  assert.equal((await readLedgerLines(dir)).filter((l) => l.seed === true).length, 1);

  await fake.handlers.turn_end(
    { type: "turn_end", turnIndex: 0, message: assistantMessage(3, 4) },
    fakeCtx("rpc"),
  );
  const turn = (await readLedgerLines(dir)).find((l) => l.m === "lmstudio/qwen3");
  assert.ok(turn, "rpc-mode turn must be recorded");
  assert.equal(turn.i, 3);
  await fake.handlers.session_shutdown({}, fakeCtx("rpc"));
});
