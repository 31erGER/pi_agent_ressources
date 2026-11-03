# PROJECT_MAP.md — Domain Term → Technical Mapping

Scope: pi agent extension work under `~/.pi/agent/` (pi install at
`~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent`).

| Domain term (human) | Technical entity / location |
|---|---|
| slash command | `pi.registerCommand(name, { description, handler(args: string, ctx: ExtensionCommandContext) })` — see `dist/core/extensions/types.d.ts:1199,1254` |
| extension entry file | `~/.pi/agent/extensions/<name>.ts` (auto-discovered, hot-reloadable via `/reload`, loaded via jiti) |
| extension project dir | `~/.pi/agent/projects/<name>/` (assets, sources, tests — NOT auto-loaded by pi) |
| theme (color palette) | JSON file conforming to `schemas/theme.schema.json`; built-ins in `dist/modes/interactive/theme/{dark,light}.json` |
| theme file fields | `name` (required), `colors` (required, 48 keys), `appearance`, `vars`, `export` (optional); 5 colors optional: `scrollbarTrack`, `scrollbarThumb`, `searchMatchBg`, `searchMatchText`, `thinkingMax` |
| color value forms | `#hex`, `oklch(l% c h)`, `okhsl(h s% l%)`, ANSI 0–255 index, var reference, `""` (terminal default) |
| "switch theme" | `ctx.ui.setTheme(name \| Theme) → { success, error? }` — on success pi persists the choice to `settings.json` (`theme` key) |
| list themes | `ctx.ui.getAllThemes() → { name, path? }[]`; current theme: `ctx.ui.theme.name` (`Theme.name?: string`) |
| ship themes from extension | `pi.on("resources_discover", …) → { themePaths: [dir] }` (fires after `session_start`, reason `startup`/`reload`) |
| theme hot-reload | ONLY for `<agent-dir>/themes/<name>.json`; other sources need `/reload` |
| reserved theme names | `system` (reserved), `/` forbidden in names, names must be unique |
| command ctx UI | `ctx.ui.select/confirm/input/notify`; `ctx.hasUI` is `true` only in TUI/RPC modes |
| user settings | `~/.pi/agent/settings.json` |

Test runtime: Node v26.13.0 executes `.ts` natively (erasable TS only) — no
framework, no jiti needed for tests. Extension itself uses `import type` only
from `@earendil-works/pi-coding-agent` (zero runtime dependency).
