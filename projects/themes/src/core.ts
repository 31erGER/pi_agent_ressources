import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pickTheme, type PickerFactory, type PickerTheme } from "./picker.ts";

/**
 * The color roles REQUIRED by pi's theme schema
 * (schemas/theme.schema.json). Five more are optional and inherit:
 * scrollbarTrack, scrollbarThumb, searchMatchBg, searchMatchText, thinkingMax.
 */
export const REQUIRED_COLORS: readonly string[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Single source of truth for the shipped, user-tweakable theme JSONs. */
export const THEMES_DIR = join(agentDir(), "projects", "themes", "themes");

/** Theme folder(s) this extension contributes to pi's theme registry. */
export function discoverThemePaths(): string[] {
  return existsSync(THEMES_DIR) ? [THEMES_DIR] : [];
}

/**
 * Structural subset of pi's ExtensionUIContext used by the command logic.
 * Kept dependency-free so tests can mock it under plain Node.
 */
export interface ThemeUI {
  /** LIVE getter in pi: the currently applied theme. */
  theme: { name?: string } & PickerTheme;
  getAllThemes(): { name: string; path?: string }[];
  getTheme(name: string): unknown | undefined;
  setTheme(theme: string | object): { success: boolean; error?: string };
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select?(title: string, options: string[]): Promise<string | undefined>;
  custom?(factory: PickerFactory): Promise<string | undefined>;
}

/** Structural subset of pi's ExtensionCommandContext (hasUI lives on the ctx). */
export interface ThemesCommandContext {
  hasUI?: boolean;
  ui: ThemeUI;
}

async function switchTheme(name: string, ui: ThemeUI): Promise<void> {
  const result = ui.setTheme(name);
  if (result.success) {
    ui.notify(`Theme: ${name}`, "info");
  } else {
    ui.notify(`Failed to set theme ${name}: ${result.error ?? "unknown error"}`, "error");
  }
}

/** Handler for `/themes [name|list]`. */
export async function handleThemesCommand(
  argsRaw: string,
  ctx: ThemesCommandContext,
): Promise<void> {
  const ui = ctx.ui;
  const args = argsRaw.trim();
  const names = ui.getAllThemes().map((t) => t.name);
  const currentName = ui.theme.name ?? "system";

  if (!args) {
    if (ctx.hasUI === false) {
      ui.notify(
        `Usage: /themes <name> | /themes list\nThemes: ${names.join(", ")} (current: ${currentName})`,
        "info",
      );
      return;
    }
    // Preferred: interactive live-preview picker.
    if (typeof ui.custom === "function") {
      await pickTheme(ui as Parameters<typeof pickTheme>[0]);
      return;
    }
    // Fallback without live preview (e.g. RPC mode).
    if (ui.select) {
      const chosen = await ui.select("Pi theme", names);
      if (chosen) await switchTheme(chosen, ui);
      return;
    }
    ui.notify(
      `Usage: /themes <name> | /themes list\nThemes: ${names.join(", ")} (current: ${currentName})`,
      "info",
    );
    return;
  }

  const [first] = args.split(/\s+/);
  if (first === "list") {
    const lines = names.map((n) => (n === currentName ? `${n} (current)` : n));
    ui.notify(`Themes — current: ${currentName}\n${lines.join("\n")}`, "info");
    return;
  }

  await switchTheme(first, ui);
}

/**
 * Validate a theme JSON the way pi's schema demands (name rules + the
 * required color roles). Returns a list of human-readable errors, [] if valid.
 */
export function validateThemeJson(fileName: string, json: unknown): string[] {
  if (typeof json !== "object" || json === null) return ["theme file is not an object"];
  const theme = json as Record<string, unknown>;

  const name = theme.name;
  if (typeof name !== "string" || name.length === 0) return ["missing 'name'"];

  const errors: string[] = [];
  const base = fileName.replace(/\.json$/i, "");
  if (name !== base) errors.push(`name '${name}' must equal the file base name '${base}'`);
  if (name === "system") errors.push("name 'system' is reserved");
  if (name.includes("/")) errors.push("name must not contain '/'");

  const colors = theme.colors;
  if (typeof colors !== "object" || colors === null) {
    errors.push("missing 'colors' object");
    return errors;
  }
  const colorRecord = colors as Record<string, unknown>;
  for (const key of REQUIRED_COLORS) {
    if (!(key in colorRecord)) errors.push(`colors: missing required '${key}'`);
  }
  return errors;
}
