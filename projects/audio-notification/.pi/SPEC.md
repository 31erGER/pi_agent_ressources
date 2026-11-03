# SPEC.md — Active Technical Specification & State Anchor

## 1. Human Requirement (Original Intent)
> When my turn finishes and Pi is waiting for my next input, play a chime
> (`~/.pi/agent/notification/notification.wav` — user chose the existing .wav
> over converting to .mp3). It should run as a lightweight,
> fire-and-forget daemon (never block the agent), with a single global volume
> variable (0–100) at the top of the file. Project lives under `~/.pi/projects`.

## 2. Technical Architecture & Data Flow
- **Core Mechanism:** A single-file Pi extension registers one notification-only
  handler on `agent_settled` — the event Pi fires only after a run has fully
  settled with no automatic retry/compaction/queued continuation remaining, i.e.
  exactly "waiting for user input again". The handler spawns `ffplay` as a
  detached, unref'd process (`stdio: "ignore"`) that plays the WAV at `-volume
  VOLUME` (ffplay's native 0–100 range). The handler returns immediately; the
  OS owns the player ("daemon" semantics: new process group, no handles held,
  survives Pi exit, no event-loop or TUI interference).
- **Data / Control Flow:**
  `Pi core (run settles) -> agent_settled event -> extension handler (guards: aborted? VOLUME>0? file exists?) -> spawn ffplay detached+unref -> daemon plays MP3 -> exit`
- **Decisions (final, approved by user):**
  1. Play the existing `notification.wav` directly — no mp3 conversion (user
     veto of the conversion default: "allright use the .wav").
  2. Skip playback when `aborted: true` (Escape) — no chime for own interruption.
  3. Kill a still-playing previous chime before spawning a new one (no overlap).
  4. `VOLUME` default: `100`.
- **Acceptance Criteria:**
  1. After any completed agent run (no pending continuation), the MP3 starts
     playing within ~100 ms of the settle; nothing in the TUI output is polluted
     by player logs.
  2. `VOLUME = 0` (or missing file / missing ffplay) → silent no-op, no error.
  3. Escaped/aborted runs produce no sound.
  4. Two rapid successive turns → second chime starts when the first is still
     playing, without overlap and without blocking Pi (input accepted instantly).
  5. Pi process exit leaves the chime running to completion (daemon behavior),
     and no zombie/leaked handle: `unref()` + `stdio: "ignore"`.
  6. Module loads cleanly via Pi's jiti runtime (no syntax/import errors) in a
     fresh Pi session.

## 3. Surgical File Map (Strict Scope Boundary)
- `~/.pi/projects/audio-notification/notify-on-settle.ts` (done, 47 lines: `VOLUME` global, `WAV_PATH`, daemon `play()` spawner, `agent_settled` handler in default-export factory)
- `~/.pi/agent/settings.json` (done: added `"extensions": ["/home/julian/.pi/projects/audio-notification/notify-on-settle.ts"]` key; all pre-existing keys untouched)
- `~/.pi/agent/notification/notification.wav` (pre-existing 562 KB asset; referenced by absolute path, unmodified)

## 4. Atomic Execution Checklist
- [x] **Step 0 (done):** Recon + scaffold: `.pi/PROJECT_MAP.md` created; event contract verified in `dist/core/extensions/types.d.ts` (`AgentSettledEvent { aborted }`, `pi.on("agent_settled", handler)` notification-only); player verified (`ffplay` present, PulseAudio active).
- [x] **Step 1 (done):** Write `notify-on-settle.ts` per §2 (guards: `aborted`, `VOLUME <= 0`, `existsSync`, spawn `{ detached: true, stdio: "ignore" }`, `unref()`, kill-previous) — verified: loaded via Pi's own jiti 2.7.0, `typeof m.default === "function"`, zero stderr.
- [x] **Step 2 (done):** Register in `~/.pi/agent/settings.json` — verified: JSON parses, `extensions` array correct, pre-existing keys intact.
- [x] **Step 3 (done):** Daemon proof: fired real `agent_settled` handler via mock `ExtensionAPI` → `ps` shows ffplay in its own process group (PGID = PID, detached), args `-nodisp -autoexit -hide_banner -loglevel quiet -volume 100 -i .../notification.wav`; `aborted: true` case confirmed silent.
- [x] **Step 4 (done, manual):** E2E — chime audible on the two test firings (heard by user's setup); will ring again at the end of this turn in the live session. Optional regression: set `VOLUME = 0` + restart Pi → silence.

## 5. Negative Knowledge (Guardrails & Taboos)
- **Do NOT touch:** `~/.pi/agent/extensions/lmstudio.ts`, `~/.pi/agent/extensions/token-counter.ts`, `notification.wav`, anything under `~/.pi/agent/install/`, other keys in `settings.json`.
- **Known Pitfalls / Failed Approaches:**
  - Do NOT use `turn_end` or `agent_end`: docs state `agent_end` is *not* a final-idle signal (retry/recovery/compaction/queued work start new runs) → double/triple chimes. `agent_settled` is the documented "notification work" event.
  - Do NOT `await` the child or pipe its stdout/stderr (blocks the handler, leaks ffplay logs into the TUI).
  - Do NOT start the player in the extension factory (docs: factory must not spawn processes; also some invocations load extensions without a session).
  - ffplay `-volume` is 0–100 (matches `VOLUME` exactly) — do not mix in amap/`-af volume=` scaling.
  - `detached: true` on POSIX = new process group (setsid); this is intentional (daemon), `child.kill()` still works on it.
  - Do NOT convert/create `notification.mp3` — user explicitly chose the `.wav` ("allright use the .wav").

## 6. Next Immediate Action
- **Status:** IMPLEMENTED & VERIFIED. Nothing pending.
- **To tweak volume:** edit `VOLUME` at the top of `notify-on-settle.ts`, then restart Pi (or `/reload` in a session).
