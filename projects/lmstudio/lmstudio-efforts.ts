/**
 * lmstudio-efforts.ts — per-model reasoning-effort mapping for the LM Studio extension.
 *
 * Pure module (no pi imports). Unit-tested by projects/lmstudio/efforts.test.mjs:
 *   node /home/julian/.pi/agent/projects/lmstudio/efforts.test.mjs
 *
 * efforts.json (co-located in this folder; override via env LM_STUDIO_EFFORTS_FILE):
 *
 *   {
 *     "<modelId>": { "<piLevel>": "<value>" | null }
 *   }
 *
 *   - piLevel: off | minimal | low | medium | high | xhigh | max (PI_LEVELS)
 *   - value:   string sent as `reasoning_effort` in the OpenAI-compatible JSON body.
 *              LM Studio 0.4.28 supports: none, minimal, low, medium, high, xhigh (verified live).
 *   - null:    level disabled (hidden from pi's thinking-level UI, never sent)
 *   - entries are auto-created with DEFAULT_ENTRY for every newly loaded model;
 *     existing entries are never deleted (stale entries are kept) and user values
 *     win over defaults; missing levels in an existing entry are backfilled with
 *     DEFAULT_ENTRY so every entry always maps all seven levels.
 *   - the file is rewritten (canonical 2-space format) only when an entry or a level
 *     is added/backfilled; an untouched file is never reformatted.
 *   - a corrupt file (invalid JSON, or valid JSON that is not an object) is renamed
 *     to efforts.json.corrupt-<timestamp> (never overwritten) and loading continues
 *     with an empty map.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiLevel = (typeof PI_LEVELS)[number];
export type LevelValue = string | null;
/** Per-model map: pi thinking level -> value sent as `reasoning_effort` (null = disabled). */
export type ModelEntry = Partial<Record<PiLevel, LevelValue>>;
/** Whole file: model id -> per-level map. */
export type EffortsFile = Record<string, ModelEntry>;

/**
 * Default entry for auto-created models.
 * LM Studio has no "off"/"max": `off -> "none"` (reasoning disabled), `max -> "xhigh"` (its top level).
 */
export const DEFAULT_ENTRY: ModelEntry = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/**
 * Resolve the efforts.json location.
 * @param extensionUrl - the importing extension's `import.meta.url` (extensions/lmstudio.ts);
 *   the file lives in ../projects/lmstudio/ relative to it. Falls back to the file
 *   co-located next to this module when omitted (used by tests/tools).
 */
function toFileUrl(candidate: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return new URL(candidate); // already has a scheme
  return new URL(`file://${candidate}`); // plain absolute path
}

export function effortsFileUrl(extensionUrl?: string): URL {
  const override = process.env.LM_STUDIO_EFFORTS_FILE;
  if (override) return toFileUrl(override);
  if (extensionUrl) return new URL("../projects/lmstudio/efforts.json", extensionUrl);
  return new URL("./efforts.json", import.meta.url);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeEntry(entry: unknown): ModelEntry {
  const out: ModelEntry = {};
  if (!isPlainObject(entry)) return out;
  for (const level of PI_LEVELS) {
    const v = entry[level];
    if (v === null) {
      out[level] = null; // explicit disable
    } else if (typeof v === "string" && v.trim() !== "") {
      out[level] = v;
    }
    // anything else (missing, empty string, non-string): dropped -> treated as absent
  }
  return out;
}

function corruptSuffix(): string {
  return `corrupt-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`; // corrupt-20261104T094700
}

/**
 * Load and sanitize efforts.json.
 * - missing file -> {}
 * - corrupt / not-an-object JSON -> original renamed to <file>.corrupt-<ts>, result {}
 * - per entry: unknown level keys dropped, empty/non-string values dropped, explicit null kept
 * - empty model ids dropped
 */
export async function loadEfforts(url: URL): Promise<EffortsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(url.pathname, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    console.warn(`[lmstudio] cannot read efforts file ${url.pathname}:`, err);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed)) {
    const backup = `${url.pathname}.${corruptSuffix()}`;
    try {
      await fs.rename(url.pathname, backup);
      console.warn(`[lmstudio] efforts file ${url.pathname} is not a valid JSON object; moved to ${backup}`);
    } catch (err) {
      console.warn(`[lmstudio] corrupt efforts file kept in place (backup failed):`, err);
    }
    return {};
  }

  const data: EffortsFile = {};
  for (const [modelId, entry] of Object.entries(parsed)) {
    if (modelId.trim() === "") continue;
    data[modelId] = sanitizeEntry(entry);
  }
  return data;
}

/**
 * Ensure every model id has an entry (auto-create with DEFAULT_ENTRY) and that every
 * existing entry maps all seven levels (backfill missing from DEFAULT_ENTRY; user
 * values and explicit nulls always win). Stale entries are kept.
 *
 * Writes the file (canonical 2-space format + trailing newline) only when something
 * changed. fs failures never throw: the in-memory result is still returned so model
 * loading can continue.
 */
export async function ensureModels(url: URL, modelIds: string[]): Promise<EffortsFile> {
  const data = await loadEfforts(url);
  let changed = false;

  for (const id of modelIds) {
    if (typeof id !== "string" || id.trim() === "") continue;
    if (!(id in data)) {
      data[id] = { ...DEFAULT_ENTRY };
      changed = true;
      continue;
    }
    const complete: ModelEntry = { ...DEFAULT_ENTRY, ...data[id] };
    if (JSON.stringify(complete) !== JSON.stringify(data[id])) {
      data[id] = complete;
      changed = true;
    }
  }

  if (changed) {
    try {
      await fs.mkdir(path.dirname(url.pathname), { recursive: true });
      await fs.writeFile(url.pathname, JSON.stringify(data, null, 2) + "\n");
    } catch (err) {
      console.warn(`[lmstudio] cannot write efforts file ${url.pathname}:`, err);
    }
  }
  return data;
}

/**
 * Build a complete pi `thinkingLevelMap` from a model entry:
 * every level present -> its value, missing/disabled -> null (level hidden from UI,
 * never sent; pi's clampThinkingLevel routes around null levels).
 */
export function entryToThinkingLevelMap(entry?: ModelEntry): Record<PiLevel, LevelValue> {
  const out = {} as Record<PiLevel, LevelValue>;
  for (const level of PI_LEVELS) {
    const v = entry?.[level];
    out[level] = typeof v === "string" && v.trim() !== "" ? v : null;
  }
  return out;
}
