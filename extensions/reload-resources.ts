/**
 * reload-resources — re-print the startup "loaded resources" block after /reload.
 *
 * Pi prints [Context], [Skills], [Prompts], [Extensions] (plus conflict
 * warnings) at the top of the transcript on startup. After `/reload` the same
 * block is re-rendered at the top of the scrollback — off-screen in a long
 * conversation — leaving only a "Reloaded" status line. This extension
 * re-prints the same block at the bottom of the transcript (where you are
 * looking) after every `/reload`.
 *
 * How it works:
 *  - `pi.registerEntryRenderer("reload-resources", ...)` — themed rendering
 *    that mirrors the built-in startup block (compact comma lists; per-scope
 *    groups when the transcript expansion state is on).
 *  - on `session_start` with `reason === "reload"` → collect →
 *    `pi.appendEntry(...)`. Custom entries are persisted in the session file
 *    and are NOT sent to the LLM.
 *
 * Discovery is display-only (nothing is executed by this extension):
 *  - skills + skill diagnostics: exported `loadSkills()` over the default
 *    user (`<agentDir>/skills`) and project (`<cwd>/.pi/skills`) dirs.
 *  - context files: exported `loadProjectContextFiles()` (AGENTS.md etc.).
 *  - prompts: `pi.getCommands()` with `source === "prompt"` (session-accurate).
 *  - extensions: the same path scan the core loader uses
 *    (`<cwd>/.pi/extensions`, `<agentDir>/extensions`, settings
 *    `extensions[]`; dir ⇒ package.json "pi.extensions" manifest, else
 *    index.ts/index.js, else file scan), deduped by resolved path.
 *    Non-existent configured paths are skipped (the core reports them as
 *    load errors, so they are not "loaded").
 *
 * Known deviations from the startup block (see
 * ~/.pi/agent/projects/reload-resources/.pi/SPEC.md):
 *  - skills from package managers / `resources_discover` handlers are not
 *    listed (only default dirs);
 *  - [Themes] and [Extension issues] sections are omitted (the loader's
 *    diagnostics state is not reachable from the extension API).
 *
 * Auto-loaded from ~/.pi/agent/extensions/.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getAgentDir,
  loadProjectContextFiles,
  loadSkills,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { trackExtensionRun } from "./stats.ts"; // global usage counter (stats extension)
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

// ------------------------------------------------------------------ types

interface SkillItem {
  name: string;
  path: string; // display path (~-prefixed)
  scope: string; // "project" | "user" | "path"
}

interface PromptItem {
  name: string;
  path: string; // display path (~-prefixed)
  scope: string;
}

interface ExtensionItem {
  label: string; // compact unique label, e.g. "lmstudio.ts"
  path: string; // display path (~-prefixed)
  scope: string;
}

interface DiagCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

interface Diag {
  type: string;
  message: string;
  path?: string;
  collision?: DiagCollision;
}

interface LoadedResourcesData {
  v: 1;
  context: string[]; // display paths (cwd-relative if under cwd, ~-prefixed otherwise)
  skills: SkillItem[];
  skillDiagnostics: Diag[];
  prompts: PromptItem[];
  extensions: ExtensionItem[];
}

// ----------------------------------------------------------------- helpers

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Absolute path with the home prefix replaced by `~` (mirrors formatDisplayPath). */
function displayPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const home = os.homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(home + path.sep)) return `~${resolved.slice(home.length)}`;
  return resolved;
}

/** cwd-relative if the path is under cwd, otherwise `~`-prefixed (mirrors formatContextPath). */
function contextDisplayPath(absolutePath: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(absolutePath);
  if (resolved === resolvedCwd) return ".";
  if (resolved.startsWith(resolvedCwd + path.sep)) return path.relative(resolvedCwd, resolved);
  return displayPath(resolved);
}

/** Map a SourceInfo to the display scope group (mirrors InteractiveMode.getScopeGroup). */
function scopeGroup(scope: string | undefined, source: string | undefined): string {
  if (source === "cli" || scope === "temporary") return "path";
  if (scope === "user") return "user";
  if (scope === "project") return "project";
  return "path";
}

function extensionScope(resolvedPath: string, cwd: string, agentDir: string): string {
  // Mirror the core rule (resource-loader.js): agent roots are checked BEFORE
  // project roots — important because the agent dir (~/.pi/agent) can itself
  // live under <cwd>/.pi.
  const agentRoot = path.resolve(agentDir, "extensions");
  if (resolvedPath === agentRoot || resolvedPath.startsWith(agentRoot + path.sep)) return "user";
  const projectRoot = path.resolve(cwd, ".pi", "extensions");
  if (resolvedPath === projectRoot || resolvedPath.startsWith(projectRoot + path.sep)) return "project";
  return "path";
}

/**
 * Compact unique labels: the shortest suffix of `~`-prefixed display path
 * segments that is unique across the list; a trailing index.ts/index.js is
 * dropped first (mirrors InteractiveMode.getCompactExtensionLabels).
 */
function compactLabels(displayPaths: string[]): string[] {
  const segLists = displayPaths.map((p) => {
    let segs = p
      .replace(/\\/g, "/")
      .split("/")
      .filter((s) => s.length > 0 && s !== "~");
    const last = segs[segs.length - 1];
    if (segs.length > 1 && (last === "index.ts" || last === "index.js")) segs.pop();
    return segs;
  });
  return segLists.map((segs, i) => {
    if (segs.length === 0) return displayPaths[i];
    for (let n = 1; n <= segs.length; n++) {
      const candidate = segs.slice(-n).join("/");
      const unique = segLists.every((other, j) => (j === i ? true : other.slice(-n).join("/") !== candidate));
      if (unique) return candidate;
    }
    return segs.join("/");
  });
}

// ------------------------------------------------- extension path discovery

const isExtensionFile = (name: string): boolean => name.endsWith(".ts") || name.endsWith(".js");

/** Mirrors the core loader: package.json "pi.extensions" manifest, else index.ts/index.js. */
function resolveExtensionEntries(dir: string): string[] | null {
  const packageJsonPath = path.join(dir, "package.json");
  if (isFile(packageJsonPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
        pi?: { extensions?: unknown };
      };
      const entries = manifest.pi?.extensions;
      if (Array.isArray(entries) && entries.length > 0) {
        const resolved: string[] = [];
        for (const entry of entries) {
          if (typeof entry === "string") {
            const full = path.resolve(dir, entry);
            if (isFile(full)) resolved.push(full);
          }
        }
        if (resolved.length > 0) return resolved;
      }
    } catch {
      // malformed manifest — fall through to index lookup
    }
  }
  const indexTs = path.join(dir, "index.ts");
  const indexJs = path.join(dir, "index.js");
  if (isFile(indexTs)) return [indexTs];
  if (isFile(indexJs)) return [indexJs];
  return null;
}

/** Mirrors the core loader: direct *.ts/*.js files + subdirs with a manifest or index. */
function discoverInDir(dir: string): string[] {
  if (!isDir(dir)) return [];
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
      found.push(full);
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const sub = resolveExtensionEntries(full);
      if (sub) found.push(...sub);
    }
  }
  return found;
}

// ------------------------------------------------------------------ collect

function collectLoadedResources(pi: ExtensionAPI, cwd: string): LoadedResourcesData | undefined {
  const agentDir = getAgentDir();

  // Skills + diagnostics (default user + project dirs).
  const { skills, diagnostics } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
  const skillItems: SkillItem[] = skills.map((s) => ({
    name: s.name,
    path: displayPath(s.filePath),
    scope: scopeGroup(s.sourceInfo?.scope, s.sourceInfo?.source),
  }));
  const skillDiagnostics: Diag[] = diagnostics.map((d) => ({
    type: d.type,
    message: d.message,
    path: d.path ? displayPath(d.path) : undefined,
    collision: d.collision
      ? {
          name: d.collision.name,
          winnerPath: displayPath(d.collision.winnerPath),
          loserPath: displayPath(d.collision.loserPath),
        }
      : undefined,
  }));

  // Context files.
  const contextItems = loadProjectContextFiles({ cwd, agentDir }).map((f) => contextDisplayPath(f.path, cwd));

  // Prompts (as actually loaded into this session).
  const promptItems: PromptItem[] = pi
    .getCommands()
    .filter((c) => c.source === "prompt")
    .map((c) => ({
      name: c.name,
      path: displayPath(c.sourceInfo.path),
      scope: scopeGroup(c.sourceInfo.scope, c.sourceInfo.source),
    }));

  // Extensions (path discovery only; order: project-local, global, configured).
  const allPaths: string[] = [];
  const seen = new Set<string>();
  const add = (paths: string[]): void => {
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved) && isFile(resolved)) {
        seen.add(resolved);
        allPaths.push(resolved);
      }
    }
  };
  add(discoverInDir(path.join(cwd, ".pi", "extensions")));
  add(discoverInDir(path.join(agentDir, "extensions")));
  const configured = pi.getSettings().extensions;
  if (Array.isArray(configured)) {
    for (const raw of configured) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
      if (isDir(resolved)) {
        const entries = resolveExtensionEntries(resolved);
        if (entries) add(entries);
        else add(discoverInDir(resolved));
        continue;
      }
      add([resolved]); // non-existent paths are skipped by add()
    }
  }
  const extensionDisplayPaths = allPaths.map((p) => displayPath(p));
  const labels = compactLabels(extensionDisplayPaths);
  const extensionItems: ExtensionItem[] = allPaths.map((p, i) => ({
    label: labels[i],
    path: extensionDisplayPaths[i],
    scope: extensionScope(p, cwd, agentDir),
  }));

  const data: LoadedResourcesData = {
    v: 1,
    context: contextItems,
    skills: skillItems,
    skillDiagnostics,
    prompts: promptItems,
    extensions: extensionItems,
  };
  const hasContent =
    data.context.length > 0 ||
    data.skills.length > 0 ||
    data.prompts.length > 0 ||
    data.extensions.length > 0 ||
    data.skillDiagnostics.length > 0;
  return hasContent ? data : undefined;
}

// -------------------------------------------------------------------- main

export default function (pi: ExtensionAPI): void {
  pi.registerEntryRenderer<LoadedResourcesData>("reload-resources", (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data || data.v !== 1) return undefined;

    const header = (name: string): string => theme.fg("mdHeading", `[${name}]`);
    const dim = (text: string): string => theme.fg("dim", text);

    const compactList = (labels: string[], sort: boolean): string => {
      const clean = labels.map((l) => l.trim()).filter((l) => l.length > 0);
      if (sort) clean.sort((a, b) => a.localeCompare(b));
      return dim(`  ${clean.join(", ")}`);
    };

    const scopeGroupList = <T extends { path: string; scope: string }>(
      items: T[],
      format: (item: T) => string,
    ): string => {
      const lines: string[] = [];
      for (const scope of ["project", "user", "path"]) {
        const group = items.filter((i) => i.scope === scope);
        if (group.length === 0) continue;
        lines.push(`  ${theme.fg("accent", scope)}`);
        for (const item of [...group].sort((a, b) => a.path.localeCompare(b.path))) {
          lines.push(dim(`    ${format(item)}`));
        }
      }
      return lines.join("\n");
    };

    const diagLines = (diags: Diag[]): string => {
      const lines: string[] = [];
      const collisions = new Map<string, Diag[]>();
      const others: Diag[] = [];
      for (const d of diags) {
        if (d.type === "collision" && d.collision) {
          const list = collisions.get(d.collision.name) ?? [];
          list.push(d);
          collisions.set(d.collision.name, list);
        } else {
          others.push(d);
        }
      }
      for (const [name, list] of collisions) {
        const first = list[0]?.collision;
        if (!first) continue;
        lines.push(theme.fg("warning", `  "${name}" collision:`));
        lines.push(theme.fg("dim", `    ${theme.fg("success", "✓")} ${first.winnerPath}`));
        for (const d of list) {
          if (d.collision) {
            lines.push(theme.fg("dim", `    ${theme.fg("warning", "✗")} ${d.collision.loserPath} (skipped)`));
          }
        }
      }
      for (const d of others) {
        const color = d.type === "error" ? "error" : "warning";
        if (d.path) {
          lines.push(theme.fg(color, `  ${d.path}`));
          lines.push(theme.fg(color, `    ${d.message}`));
        } else {
          lines.push(theme.fg(color, `  ${d.message}`));
        }
      }
      return lines.join("\n");
    };

    const container = new Container();
    const addSection = (name: string, collapsed: string, expandedBody?: string): void => {
      const body = expanded ? (expandedBody ?? collapsed) : collapsed;
      container.addChild(new Text(`${header(name)}\n${body}`, 0, 0));
      container.addChild(new Spacer(1));
    };

    if (data.context.length > 0) {
      addSection("Context", compactList(data.context, false), data.context.map((p) => dim(`  ${p}`)).join("\n"));
    }
    if (data.skills.length > 0) {
      addSection("Skills", compactList(data.skills.map((s) => s.name), true), scopeGroupList(data.skills, (s) => s.path));
    }
    if (data.prompts.length > 0) {
      addSection(
        "Prompts",
        compactList(data.prompts.map((p) => `/${p.name}`), true),
        scopeGroupList(data.prompts, (p) => `/${p.name}`),
      );
    }
    if (data.extensions.length > 0) {
      addSection(
        "Extensions",
        compactList(data.extensions.map((e) => e.label), true),
        scopeGroupList(data.extensions, (e) => e.path),
      );
    }
    if (data.skillDiagnostics.length > 0) {
      container.addChild(
        new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${diagLines(data.skillDiagnostics)}`, 0, 0),
      );
      container.addChild(new Spacer(1));
    }

    return container;
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "reload") return;
    if (ctx.mode !== "tui") return;
    trackExtensionRun(import.meta.url); // /stats global usage counter (one run per /reload)
    let data: LoadedResourcesData | undefined;
    try {
      data = collectLoadedResources(pi, ctx.cwd);
    } catch {
      return; // never break /reload over a listing failure
    }
    if (!data) return;
    try {
      pi.appendEntry<LoadedResourcesData>("reload-resources", data);
    } catch {
      // non-fatal
    }
  });
}
