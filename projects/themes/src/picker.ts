/**
 * Live-preview theme picker for pi.
 *
 * Plain-object component — no pi-tui import — so it runs and is tested under
 * plain Node. pi's `ui.custom()` runtime accepts render/handleInput alone,
 * but pi's `Component` type requires `invalidate`, so PickerComponent
 * declares it required and the picker always provides it.
 *
 * Preview semantics (verified in interactive-mode.js):
 *  - setTheme(ThemeInstance)  -> applied, NOT persisted  (used while browsing)
 *  - setTheme("name")         -> applied AND persisted   (used on Enter only)
 */

export interface PickerKeybindings {
  matches(data: string, name: string): boolean;
}

export interface PickerComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  /** Required by pi's `Component` type (and always provided below). */
  invalidate(): void;
}

export interface PickerTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

export type PickerFactory = (
  tui: unknown,
  theme: PickerTheme,
  keybindings: PickerKeybindings,
  done: (value: string | undefined) => void,
) => PickerComponent;

export interface PickerUI {
  /** LIVE getter: reflects the currently applied theme (changes during preview). */
  theme: { name?: string } & PickerTheme;
  getAllThemes(): { name: string; path?: string }[];
  /** Load a theme by name without switching to it. */
  getTheme(name: string): unknown | undefined;
  setTheme(theme: string | object): { success: boolean; error?: string };
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Resolves with the value passed to `done()` (string) or undefined on cancel. */
  custom(factory: PickerFactory): Promise<string | undefined>;
}

const PAGE = 5;

export async function pickTheme(ui: PickerUI): Promise<void> {
  const options = ui.getAllThemes();
  if (options.length === 0) {
    ui.notify("No themes available.", "warning");
    return;
  }

  const currentName = ui.theme.name ?? "system";
  // Instance of the theme we opened with — used to revert on Esc (no persist).
  const previousTheme = ui.getTheme(currentName);

  let index = options.findIndex((t) => t.name === currentName);
  if (index < 0) index = 0;
  let previewed: string | null = null;

  const preview = (i: number): void => {
    const name = options[i].name;
    if (name === previewed) return;
    const theme = ui.getTheme(name);
    if (theme) ui.setTheme(theme); // instance form: visual only, not persisted
    previewed = name;
  };

  const chosen = await ui.custom((_tui, _theme, keybindings, done) => ({
    render(): string[] {
      // Read the LIVE theme every render so the previewed palette is what
      // the user actually sees (the factory's `theme` arg is a snapshot).
      const t = ui.theme;
      const lines: string[] = [];
      lines.push(t.fg("accent", "Choose a theme - arrows preview instantly"));
      options.forEach((opt, i) => {
        const label = `${opt.name}${opt.name === currentName ? "  (current)" : ""}`;
        lines.push(
          i === index
            ? t.bg("selectedBg", t.fg("text", label))
            : `  ${t.fg("muted", label)}`,
        );
      });
      lines.push(t.fg("dim", "up/down preview · Enter keep · Esc revert"));
      return lines;
    },
    handleInput(data: string): void {
      if (keybindings.matches(data, "tui.select.up")) {
        index = (index - 1 + options.length) % options.length;
        preview(index);
      } else if (keybindings.matches(data, "tui.select.down")) {
        index = (index + 1) % options.length;
        preview(index);
      } else if (keybindings.matches(data, "tui.select.pageUp")) {
        index = (index - PAGE + options.length) % options.length;
        preview(index);
      } else if (keybindings.matches(data, "tui.select.pageDown")) {
        index = (index + PAGE) % options.length;
        preview(index);
      } else if (keybindings.matches(data, "tui.select.confirm")) {
        done(options[index].name);
      } else if (keybindings.matches(data, "tui.select.cancel")) {
        done(undefined);
      }
    },
    invalidate(): void {},
  }));

  if (chosen === undefined) {
    // Silent revert to the theme we opened with (instance form: no persist).
    if (previousTheme) ui.setTheme(previousTheme);
    return;
  }

  // String form: pi applies the theme AND persists it to settings.json.
  const result = ui.setTheme(chosen);
  if (result.success) {
    ui.notify(`Theme: ${chosen}`, "info");
  } else {
    ui.notify(`Failed to set theme ${chosen}: ${result.error ?? "unknown error"}`, "error");
  }
}
