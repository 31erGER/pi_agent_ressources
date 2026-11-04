/**
 * dynamic-efforts.ts — pure logic for the /efforts extension command.
 * No pi imports; unit-tested by dynamic-efforts.test.mjs (node:test).
 */
import {
  type LevelValue,
  type ModelEntry,
  type PiLevel,
  PI_LEVELS,
  DEFAULT_ENTRY,
} from "../lmstudio/lmstudio-efforts.ts";

/** Minimal model shape needed to derive the toggleable thinking-level set. */
export type OptionsLike = {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<PiLevel, string | null>>;
};

/**
 * Parse the argument of `/efforts <levels>`.
 * Accepts comma- and/or whitespace-separated tokens, case-insensitive,
 * deduped, returned in canonical PI_LEVELS order.
 * Returns null when the argument is empty or contains an unknown token
 * (the caller shows the valid list in that case).
 */
export function parseLevelsArg(
  arg: string | null | undefined,
): readonly PiLevel[] | null {
  if (!arg) return null;
  const seen = new Set<PiLevel>();
  for (const raw of arg.split(/[\s,]+/)) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (!(PI_LEVELS as readonly string[]).includes(token)) return null;
    seen.add(token as PiLevel);
  }
  if (seen.size === 0) return null;
  return PI_LEVELS.filter((level) => seen.has(level));
}

function valueFor(level: PiLevel, prev: ModelEntry | undefined): LevelValue {
  const existing = prev?.[level];
  if (typeof existing === "string" && existing.trim() !== "") return existing;
  // DEFAULT_ENTRY covers all seven levels at runtime; "none" is the type-level
  // fallback for a null/absent default (still a valid LM Studio effort value).
  return DEFAULT_ENTRY[level] ?? "none";
}

/**
 * Build the full 7-key ModelEntry for `/efforts <levels>`:
 * listed levels keep their existing (non-blank) value or fall back to
 * DEFAULT_ENTRY; unlisted levels are set to null (hidden in the TUI).
 */
export function applyEffortArray(
  prev: ModelEntry | undefined,
  levels: readonly PiLevel[],
): ModelEntry {
  const set = new Set<PiLevel>(levels);
  const entry = {} as ModelEntry;
  for (const level of PI_LEVELS) {
    entry[level] = set.has(level) ? valueFor(level, prev) : null;
  }
  return entry;
}

/**
 * Mirror of pi-ai getSupportedThinkingLevels (verified in 1.5.0,
 * dist/models.js:694) used to display/compare option sets:
 *  - non-reasoning model -> ["off"]
 *  - null map entry -> level hidden (any level)
 *  - xhigh/max -> only when explicitly mapped (non-null)
 *  - off/minimal/low/medium/high -> available by default for reasoning models
 */
export function levelsFromModel(model: OptionsLike): readonly PiLevel[] {
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap;
  const out: PiLevel[] = [];
  for (const level of ["off", ...PI_LEVELS.slice(1)] as PiLevel[]) {
    const mapped = map?.[level];
    if (mapped === null) continue;
    if ((level === "xhigh" || level === "max") && mapped === undefined) continue;
    out.push(level);
  }
  return out;
}

/**
 * Whether two model option sets differ (derived level sets, not raw map
 * values). Drives the guarded pi.setModel: only swap the active model
 * object when its toggleable levels actually changed.
 */
export function optionsDiffer(a: OptionsLike, b: OptionsLike): boolean {
  const la = levelsFromModel(a);
  const lb = levelsFromModel(b);
  return la.length !== lb.length || la.some((lvl, i) => lvl !== lb[i]);
}
