import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_COLORS,
  discoverThemePaths,
  handleThemesCommand,
  validateThemeJson,
} from "../src/core.ts";
import { pickTheme } from "../src/picker.ts";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const themesDir = join(projectDir, "themes");

// ---------- tiny test harness ----------
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

// ---------- mock UI ----------
const BUILTIN = ["system", "dark", "light"];
const CUSTOM = ["mint", "sunset", "frost"];
const ALL = [...BUILTIN, ...CUSTOM];

type PickerFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: { matches(data: string, name: string): boolean },
  done: (value: string | undefined) => void,
) => { handleInput(data: string): void; render(width: number): string[] };

function makeUi(currentName: string, overrides: Record<string, unknown> = {}) {
  const calls = {
    setTheme: [] as unknown[],
    notify: [] as { msg: string; type?: string }[],
    select: [] as { title: string; options: string[] }[],
    getTheme: [] as string[],
    factory: undefined as unknown,
  };
  const themeObjects: Record<string, object> = Object.fromEntries(ALL.map((n) => [n, { kind: n }]));
  const liveTheme = {
    name: currentName,
    fg: (color: string, text: string) => `[${color}]${text}`,
    bg: (color: string, text: string) => `<${color}>${text}`,
    bold: (text: string) => `**${text}**`,
  };
  const ui = {
    hasUI: true,
    get theme() {
      return liveTheme;
    },
    getAllThemes: () => ALL.map((n) => ({ name: n, path: `/fake/${n}.json` })),
    getTheme: (name: string) => {
      calls.getTheme.push(name);
      return themeObjects[name] ?? undefined;
    },
    setTheme: (t: unknown) => {
      calls.setTheme.push(t);
      if (typeof t === "string") return { success: ALL.includes(t) };
      return { success: true };
    },
    notify: (msg: string, type?: string) => {
      calls.notify.push({ msg, type });
    },
    select: async (title: string, options: string[]) => {
      calls.select.push({ title, options });
      return (overrides.selectResult as string | undefined) ?? undefined;
    },
    custom: (factory: PickerFactory) => {
      calls.factory = factory;
      const drive = overrides.drive as
        | ((factory: PickerFactory, done: (v: string | undefined) => void) => void)
        | undefined;
      return new Promise<string | undefined>((resolvePromise) => {
        const done = (v: string | undefined) => resolvePromise(v);
        if (drive) drive(factory, done);
        // Without a driver the promise stays pending: opening the picker in a
        // test without drive() is a test bug, not a silent no-op.
      });
    },
    ...overrides,
  };
  return { ui, calls, themeObjects };
}

// Drives the picker through the mocked ui.custom: synchronously creates the
// component, then the test presses keys via session.component.
function openPicker(currentName: string) {
  const session: { component?: { handleInput(data: string): void; render(width: number): string[] } } = {};
  const { ui, calls, themeObjects } = makeUi(currentName, {
    drive: (factory: PickerFactory, done: (v: string | undefined) => void) => {
      const keybindings = { matches: (data: string, name: string) => data === name };
      session.component = factory({}, undefined, keybindings, done);
    },
  });
  const promise = pickTheme(ui);
  return { session, calls, themeObjects, promise };
}
const press = (session: { component?: { handleInput(data: string): void } }, key: string) =>
  session.component?.handleInput(key);

// ---------- command dispatch ----------
await test("direct switch: /themes mint -> setTheme('mint') + info", async () => {
  const { ui, calls } = makeUi("dark");
  await handleThemesCommand("mint", { hasUI: true, ui });
  assert.deepEqual(calls.setTheme, ["mint"]);
  assert.ok(calls.notify.some((n) => n.type === "info" && n.msg.includes("mint")));
});

await test("direct switch: unknown name -> error notification", async () => {
  const { ui, calls } = makeUi("dark");
  await handleThemesCommand("nope", { hasUI: true, ui });
  assert.deepEqual(calls.setTheme, ["nope"]);
  assert.ok(calls.notify.some((n) => n.type === "error" && n.msg.includes("nope")));
});

await test("list: prints all themes, marks current, no switch", async () => {
  const { ui, calls } = makeUi("dark");
  await handleThemesCommand("list", { hasUI: true, ui });
  assert.equal(calls.setTheme.length, 0);
  const note = calls.notify.find((n) => n.type === "info");
  assert.ok(note, "should notify a list");
  for (const name of ALL) assert.ok(note!.msg.includes(name), `missing ${name}`);
  assert.ok(note!.msg.includes("dark (current)"));
});

await test("no args + UI + custom -> opens live picker", async () => {
  const { ui, calls } = makeUi("dark", {
    drive: (_factory: PickerFactory, done: (v: string | undefined) => void) => done(undefined),
  });
  await handleThemesCommand("", { hasUI: true, ui });
  assert.equal(typeof calls.factory, "function");
});

await test("no args + UI, no custom -> select() fallback, then persist", async () => {
  const { ui, calls } = makeUi("dark", { custom: undefined, selectResult: "sunset" });
  await handleThemesCommand("", { hasUI: true, ui });
  assert.equal(calls.select.length, 1);
  assert.deepEqual(calls.select[0].options, ALL);
  assert.deepEqual(calls.setTheme, ["sunset"]);
  assert.ok(calls.notify.some((n) => n.type === "info"));
});

await test("no args + no UI -> usage notification only", async () => {
  const { ui, calls } = makeUi("dark");
  await handleThemesCommand("", { hasUI: false, ui });
  assert.equal(calls.select.length, 0);
  assert.equal(calls.factory, undefined);
  assert.ok(calls.notify.some((n) => n.type === "info" && n.msg.includes("Usage")));
});

// ---------- picker: live preview ----------
await test("picker: starts on current theme (first down -> theme after current)", async () => {
  const { session, calls, themeObjects, promise } = openPicker("dark");
  press(session, "tui.select.down");
  assert.deepEqual(calls.setTheme, [themeObjects.light]);
  press(session, "tui.select.cancel");
  await promise;
});

await test("picker: previews via INSTANCE form while browsing (nothing persisted)", async () => {
  const { session, calls, themeObjects, promise } = openPicker("dark");
  press(session, "tui.select.down"); // light
  press(session, "tui.select.down"); // mint
  for (const t of calls.setTheme) assert.notEqual(typeof t, "string", "no persisted switch while browsing");
  assert.deepEqual(calls.setTheme, [themeObjects.light, themeObjects.mint]);
  press(session, "tui.select.cancel");
  await promise;
});

await test("picker: unrelated key does not re-preview", async () => {
  const { session, calls, themeObjects, promise } = openPicker("dark");
  press(session, "tui.select.down"); // light
  press(session, "x"); // ignored
  assert.deepEqual(calls.setTheme, [themeObjects.light]);
  press(session, "tui.select.cancel");
  await promise;
});

await test("picker: navigation wraps around at both ends", async () => {
  const { session, calls, themeObjects, promise } = openPicker("frost");
  press(session, "tui.select.down"); // wraps -> system
  press(session, "tui.select.up"); // wraps -> frost
  assert.deepEqual(calls.setTheme, [themeObjects.system, themeObjects.frost]);
  press(session, "tui.select.cancel");
  await promise;
});

await test("picker: Enter confirms -> persisted by NAME + info notify", async () => {
  const { session, calls, promise } = openPicker("dark");
  press(session, "tui.select.down"); // light
  press(session, "tui.select.down"); // mint
  press(session, "tui.select.confirm");
  await promise;
  assert.equal(calls.setTheme.at(-1), "mint", "final switch must be the string name (persisted)");
  assert.ok(calls.notify.some((n) => n.type === "info" && n.msg.includes("mint")));
});

await test("picker: Esc restores previous theme by instance, silent, no persist", async () => {
  const { session, calls, themeObjects, promise } = openPicker("dark");
  press(session, "tui.select.down"); // light
  press(session, "tui.select.cancel");
  await promise;
  assert.equal(calls.setTheme.at(-1), themeObjects.dark, "restore previous theme instance");
  assert.ok(!calls.setTheme.some((t) => typeof t === "string"), "nothing persisted");
  assert.equal(calls.notify.length, 0, "silent revert");
});

await test("picker: immediate Esc -> nothing persisted, silent", async () => {
  const { session, calls, promise } = openPicker("dark");
  press(session, "tui.select.cancel");
  await promise;
  assert.ok(!calls.setTheme.some((t) => typeof t === "string"));
  assert.equal(calls.notify.length, 0);
});

await test("picker: render uses live theme + hints line", async () => {
  const { session, promise } = openPicker("dark");
  const lines = session.component?.render(80) ?? [];
  assert.ok(lines.length >= 8, "header + 6 themes + hint");
  assert.ok(lines.some((l) => l.includes("Enter")), "hint about Enter");
  assert.ok(lines.some((l) => l.includes("[muted]") || l.includes("[text]")), "styled rows");
  press(session, "tui.select.cancel");
  await promise;
});

// ---------- theme JSON validation ----------
const validColors = () => Object.fromEntries(REQUIRED_COLORS.map((c) => [c, "text"]));

await test("validateThemeJson: full valid theme -> []", () => {
  assert.deepEqual(
    validateThemeJson("mint.json", {
      $schema: "x",
      name: "mint",
      appearance: "dark",
      vars: { a: "okhsl(1 1% 1%)" },
      colors: validColors(),
    }),
    [],
  );
});

await test("validateThemeJson: name != filename -> error", () => {
  const errs = validateThemeJson("mint.json", { name: "other", colors: validColors() });
  assert.ok(errs.some((e) => e.includes("name") && e.includes("other")));
});

await test("validateThemeJson: missing required color -> error names it", () => {
  const colors = validColors();
  delete colors.accent;
  const errs = validateThemeJson("mint.json", { name: "mint", colors });
  assert.ok(errs.some((e) => e.includes("accent")));
});

await test("validateThemeJson: reserved name 'system' -> error", () => {
  assert.ok(validateThemeJson("system.json", { name: "system", colors: validColors() }).length > 0);
});

await test("validateThemeJson: name with '/' -> error", () => {
  assert.ok(validateThemeJson("a-b.json", { name: "a/b", colors: validColors() }).length > 0);
});

await test("validateThemeJson: missing colors -> error", () => {
  assert.ok(validateThemeJson("x.json", { name: "x" }).length > 0);
});

await test("shipped themes: mint/sunset/frost exist and all validate", () => {
  const files = readdirSync(themesDir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["frost.json", "mint.json", "sunset.json"]);
  for (const f of files) {
    const json = JSON.parse(readFileSync(join(themesDir, f), "utf8"));
    assert.deepEqual(validateThemeJson(f, json), [], `${f} should validate`);
  }
});

await test("discoverThemePaths: points at the existing shipped themes dir", () => {
  const paths = discoverThemePaths();
  assert.equal(paths.length, 1);
  assert.ok(existsSync(paths[0]));
  assert.ok(paths[0].endsWith("themes"));
});

console.log(`core: ${passes} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;
