import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import extensionFactory from "../../../extensions/themes.ts";

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
  }
}

const seen: {
  commands: Record<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
  events: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
} = { commands: {}, events: {} };

extensionFactory({
  on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
    seen.events[name] = handler;
  },
  registerCommand: (
    name: string,
    options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
  ) => {
    seen.commands[name] = options;
  },
} as never);

await test("extension registers the /themes command", () => {
  assert.ok(seen.commands.themes, "command 'themes' is registered");
  assert.ok(seen.commands.themes.description.length > 0, "has a description");
});

await test("extension advertises the theme dir via resources_discover", async () => {
  assert.ok(seen.events.resources_discover, "subscribed to resources_discover");
  const res = (await seen.events.resources_discover({ cwd: "/tmp", reason: "startup" }, {})) as {
    themePaths: string[];
  };
  assert.ok(Array.isArray(res.themePaths) && res.themePaths.length === 1, "one theme path");
  assert.ok(existsSync(res.themePaths[0]), "theme path exists");
  assert.ok(res.themePaths[0].endsWith("themes"), "points at a themes dir");
});

await test("command handler is wired to core (list works end to end)", async () => {
  const notes: string[] = [];
  // Command handlers receive an ExtensionCommandContext; the UI lives on ctx.ui.
  const ctx = {
    ui: {
      hasUI: false,
      theme: { name: "system" },
      getAllThemes: () => [{ name: "system" }, { name: "mint" }],
      getTheme: () => undefined,
      setTheme: () => ({ success: true }),
      notify: (msg: string) => notes.push(msg),
    },
  };
  await seen.commands.themes.handler("list", ctx);
  assert.ok(notes.some((m) => m.includes("system") && m.includes("mint")), "list output");
});

console.log(`extension: ${passes} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;
