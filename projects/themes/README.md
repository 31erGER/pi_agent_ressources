# pi /themes — live-preview theme switcher

A pi extension that adds the `/themes` slash command and ships three example
themes as plain JSON you can tweak.

## Usage

| Command | What it does |
|---|---|
| `/themes` | Interactive picker. **Arrow keys preview each theme instantly** — the UI recolors as you browse. `Enter` keeps the theme (and saves it), `Esc` reverts to the theme you had before. PageUp/PageDown jump 5. |
| `/themes mint` | Switch directly by name (`mint`, `sunset`, `frost`, or built-in `dark` / `light` / `system`). |
| `/themes list` | Print all theme names, current one marked. |

Choosing a theme is persisted to `~/.pi/agent/settings.json` (`"theme"` key),
so it survives restarts. Browsing/previewing in the picker does **not** touch
the saved setting — only `Enter` (or `/themes <name>`) does. `/themes system`
restores the terminal-following default.

## Files

```
~/.pi/agent/
├── extensions/themes.ts            # extension entry (thin: registers /themes)
└── projects/themes/
    ├── themes/                     # ← THE THEME FILES. Tweak these.
    │   ├── mint.json               # dark — mint/teal
    │   ├── sunset.json             # dark — warm coral/amber/pink
    │   └── frost.json              # light — cool ice-blue/slate
    ├── src/
    │   ├── core.ts                 # command logic + theme JSON validation
    │   └── picker.ts               # live-preview picker component
    ├── test/                       # unit tests (plain Node, no framework)
    │   ├── core.test.ts
    │   └── extension.test.ts
    └── package.json
```

Run the tests anytime:

```bash
cd ~/.pi/agent/projects/themes && npm test
```

## Tweaking a theme

Every color in `themes/*.json` is yours to change. Two layers:

- **`vars`** — reusable color definitions. Change one var (e.g. `"mint"`) and
  every role referencing it changes with it. This is the fastest way to
  re-hue a theme.
- **`colors`** — role → color assignments. Point a role at a var
  (`"accent": "mint"`) or at a literal color value.

Color values come in six forms:

| Form | Example | Notes |
|---|---|---|
| OKHSL | `okhsl(250 60% 55%)` | `hue saturation% lightness%` — what the built-ins use; every value is in gamut |
| OKLCH | `oklch(62% 0.1 200)` | perceptual `lightness% chroma hue` |
| Hex | `#0af` / `#00aaff` | plain sRGB |
| ANSI index | `39` | 0–255, approximated on truecolor terminals |
| Var reference | `mint` | the value of a `vars` entry (chaining works) |
| Terminal default | `""` | the terminal's own fg/bg |

### Where to look for the color you want

| You see in the UI | Role to change |
|---|---|
| selection highlight | `selectedBg` |
| your message bubbles | `userMessageBg` / `userMessageText` |
| tool boxes (pending / ok / failed) | `toolPendingBg`, `toolSuccessBg`, `toolErrorBg` |
| prompt accent, bullets | `accent`, `mdListBullet` |
| syntax highlighting | `syntaxKeyword`, `syntaxString`, … |
| thinking-level border colors | `thinkingOff` … `thinkingMax` |
| `!` bash mode border | `bashMode` |
| HTML export backgrounds | `export.pageBg` / `cardBg` / `infoBg` |

### Rules pi enforces (the tests check these too)

- `name` must equal the file's base name (`mint.json` → `"name": "mint"`).
- `name` may not be `system` and may not contain `/`.
- All 51 required `colors` roles must be present (5 more are optional and
  inherit: `scrollbarTrack`, `scrollbarThumb`, `searchMatchBg`,
  `searchMatchText`, `thinkingMax`).
- Unknown top-level fields or color keys are rejected — only use documented
  roles. See `https://pi.dev/schemas/theme.schema.json` for the full schema.

### Applying changes

These themes are contributed by the extension (via `resources_discover`), so
pi only hot-reloads themes that live in `~/.pi/agent/themes/`. After editing a
file here, run **`/reload`** in pi — the new colors apply immediately and the
picker previews them too. Invalid theme files are reported at that point.

## Adding your own theme

1. Copy `themes/mint.json` to `themes/my-theme.json`.
2. Set `"name": "my-theme"`.
3. Adjust `vars` and `colors`.
4. `/reload`, then `/themes my-theme`.

## Development notes

- `src/core.ts` and `src/picker.ts` are dependency-free (no pi imports) so the
  tests run under plain Node: `node test/core.test.ts && node test/extension.test.ts`.
- Live preview works because pi's `setTheme(ThemeInstance)` applies a theme
  **without** persisting, while `setTheme("name")` applies **and** persists.
  The picker previews with the instance form and commits with the name form.
- The picker is a plain object passed to `ctx.ui.custom()` (no pi-tui import);
  it renders through the live `ctx.ui.theme` getter so the previewed palette
  is what you actually see while browsing.
