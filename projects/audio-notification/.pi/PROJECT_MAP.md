# PROJECT_MAP.md — Domain → Code Map

Project: **audio-notification**
Location: `~/.pi/projects/audio-notification/`
Stack: single-file TypeScript Pi extension (loaded via `jiti`, no build step), FFmpeg/ffplay for audio.

| Human term | Technical mapping |
|---|---|
| "Play the sound when my turn is done" | `pi.on("agent_settled", ...)` handler in `notify-on-settle.ts` (fires only after all retries/compaction/queued continuations are exhausted — the true "waiting for user input" moment). NOT `turn_end` / `agent_end`. |
| "The notification file" | `~/.pi/agent/notification/notification.wav` (existing 562 KB asset, played directly — user vetoed mp3 conversion). |
| "Volume from 0 to 100" | `const VOLUME` at the top of `notify-on-settle.ts`, passed 1:1 to `ffplay -volume` (ffplay's native range is 0–100). |
| "Daemon" | Playback subprocess spawned with `{ detached: true, stdio: "ignore" }` + `unref()` — fire-and-forget, no handles held, no stdio pipes, survives/keeps running independently of the Pi event loop. |
| "The extension" | `notify-on-settle.ts` (single file, default-export factory receiving `ExtensionAPI`). |
| "Make it active" | `"extensions": ["<abs path>/notify-on-settle.ts"]` entry in `~/.pi/agent/settings.json` (documented resource array in settings.md). |

## Files
- `notify-on-settle.ts` — the entire feature (global `VOLUME`, play() daemon spawner, `agent_settled` handler).
- `~/.pi/agent/settings.json` — registration only (`extensions` array). Untouched otherwise.
- `~/.pi/agent/notification/` — audio asset (`notification.wav`). Not part of the project, referenced by absolute path.

## Out of scope / must not touch
- `~/.pi/agent/extensions/lmstudio.ts`, `~/.pi/agent/extensions/token-counter.ts` (existing user extensions).
- `notification.wav` (kept as source).
- Any Pi core package files under `~/.pi/agent/install/`.
