/**
 * Notification chime — plays the turn-done sound the moment Pi settles
 * (run fully finished, waiting for user input again).
 *
 * Also exports chime(), which confirmation-dialog.ts rings the moment its
 * dialog pops up: you hear a bell every time the session needs you —
 * turn settle AND confirmation prompt. One chime at a time (shared state).
 *
 * Playback runs as a detached, unref'd daemon (ffplay): the handler returns
 * immediately, no stdio is piped, and the sound survives Pi exiting.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trackExtensionRun } from "./stats.ts"; // global usage counter (stats extension)

// ── Global settings ──────────────────────────────────────────────────────────
const VOLUME = 100; // 0–100, maps 1:1 to ffplay -volume; 0 = mute

const WAV_PATH = "/home/julian/.pi/agent/notification/notification.wav";
const PLAYER = "ffplay";

let current: ChildProcess | null = null;

/** Fire-and-forget daemon spawn. Never blocks, never overlaps.
 *  Shared bell: called by agent_settled (below) and by confirmation-dialog.ts. */
export function chime(): void {
  if (VOLUME <= 0 || !existsSync(WAV_PATH)) return;
  trackExtensionRun(import.meta.url); // /stats global usage counter (one run per chime)
  current?.kill("SIGKILL"); // a new chime was due before the last one finished
  const child = spawn(
    PLAYER,
    [
      "-nodisp", "-autoexit", "-hide_banner", "-loglevel", "quiet",
      "-volume", String(VOLUME),
      "-i", WAV_PATH,
    ],
    { detached: true, stdio: "ignore" },
  );
  current = child;
  child.on("exit", () => {
    if (current === child) current = null;
  });
  child.on("error", () => {
    // e.g. ffplay missing: reset state, never let an unhandled 'error' crash pi
    if (current === child) current = null;
  });
  child.unref(); // daemonize: Pi neither waits for it nor is blocked by it
}

export default function (pi: ExtensionAPI): void {
  // agent_settled: fires only after ALL automatic continuations (retries,
  // recovery, compaction, queued work) are exhausted — the true idle moment.
  pi.on("agent_settled", (event) => {
    if (event.aborted) return; // no chime for your own Escape
    chime();
  });
}
