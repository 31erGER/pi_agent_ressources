/**
 * message-markers — right-edge marker rail for your own messages (fullscreen mode).
 *
 * Renders a vertical column of markers on the right side of the fullscreen
 * transcript viewport, vertically centered — one marker per user message you
 * sent. The marker of the user message you are currently at in the message
 * flow is highlighted.
 *
 * Keys (fullscreen only):
 *   alt+up    jump to the previous user message
 *   alt+down  jump to the next user message
 *
 * Commands:
 *   /markers            show status
 *   /markers on         (re-)enable the rail
 *   /markers off        disable the rail and restore the original layout
 *
 * Design notes (see ~/.pi/SPEC.md):
 * - The rail is NOT a TUI overlay: a persistent overlay blocks
 *   fullscreen/regular mode switching (pi checks hasOverlayEntries). Instead
 *   the fullscreen layout root is wrapped via the public
 *   ViewportTUI.setLayoutRoot() and the rail lines are composited with the
 *   exported compositeTuiLine(). The wrapper delegates its layout node to the
 *   wrapped root so layout sizing, wheel scrolling, the scrollbar and text
 *   selection keep working 1:1.
 * - A new layout root appears each time a new TuiAltScreen starts (startup,
 *   every mode switch), so the rail is installed from (a) a one-time,
 *   idempotent patch of TuiAltScreen.prototype.start and (b) a live-TUI
 *   capture in session_start (covers the initial TUI that starts before
 *   extensions load).
 * - User messages are identified by their rendered component shape in the
 *   transcript tree (UserMessageComponent duck-type: string `text` + array
 *   `markdownTransformers` + no `message` field). OSC 133 zone markers are
 *   not used — assistant messages embed the same markers.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	isViewportTUI,
	matchesKey,
	ScrollView,
	TuiAltScreen,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

// Opt-in debug logging: MESSAGE_MARKERS_DEBUG=/path/to/log
const DEBUG_FILE = process.env.MESSAGE_MARKERS_DEBUG;
let lastOverlayLog = 0;
function dbg(...parts: unknown[]): void {
	if (!DEBUG_FILE) return;
	try {
		const line = parts
			.map((p) => (typeof p === "string" ? p : p instanceof Error ? p.stack ?? String(p) : JSON.stringify(p)))
			.join(" ");
		fs.appendFileSync(DEBUG_FILE, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// debug logging must never break the extension
	}
}
function className(v: unknown): string {
	return v && typeof v === "object" ? (v as { constructor?: { name?: string } }).constructor?.name ?? "?" : String(v);
}

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in ~/.pi/agent/projects/message-markers/tests/)
// ---------------------------------------------------------------------------

/**
 * Duck-type for the runtime shape of pi's UserMessageComponent
 * (dist/modes/interactive/components/user-message.js):
 * `text` (string) + `markdownTransformers` (array). Assistant messages also
 * carry `markdownTransformers` but additionally have a `message` field.
 */
export function isUserMessageLike(node: unknown): boolean {
	if (typeof node !== "object" || node === null) return false;
	const n = node as Record<string, unknown>;
	return typeof n.text === "string" && Array.isArray(n.markdownTransformers) && !("message" in n);
}

function childrenOf(node: unknown): unknown[] | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	const c = (node as { children?: unknown }).children;
	return Array.isArray(c) ? (c as unknown[]) : undefined;
}

function lineCount(node: unknown, width: number): number {
	if (typeof node !== "object" || node === null) return 0;
	const render = (node as { render?: unknown }).render;
	if (typeof render === "function") {
		try {
			const lines = (render as (w: number) => unknown).call(node, width);
			return Array.isArray(lines) ? lines.length : 0;
		} catch {
			return 0;
		}
	}
	// Render-less container: sum the rendered heights of its children.
	const subs = childrenOf(node);
	if (!subs) return 0;
	let total = 0;
	for (const s of subs) total += lineCount(s, width);
	return total;
}

/**
 * Compute the start row (relative to the transcript document) of every user
 * message. `document` is the transcript ScrollView's child: a Container whose
 * direct children are [headerContainer, loadedResourcesContainer,
 * chatContainer]; user messages are direct children of the chat container.
 */
export function collectUserMessageOffsets(document: unknown, width: number): number[] {
	const docChildren = childrenOf(document);
	if (!docChildren) return [];
	const startRows: number[] = [];
	let row = 0;
	for (const child of docChildren) {
		if (isUserMessageLike(child)) {
			startRows.push(row);
			row += lineCount(child, width);
			continue;
		}
		const subs = childrenOf(child);
		if (subs && subs.some((s) => isUserMessageLike(s))) {
			if (DEBUG_FILE) {
				// Render for diagnostics only; never in the normal path.
				dbg(
					"collect: chat container found, children:",
					subs.map((s) => ({ c: className(s), user: isUserMessageLike(s), lines: lineCount(s, width) })).slice(0, 12),
				);
			}
			for (const sub of subs) {
				if (isUserMessageLike(sub)) startRows.push(row);
				row += lineCount(sub, width);
			}
		} else {
			row += lineCount(child, width);
		}
	}
	if (DEBUG_FILE) dbg("collect: doc children:", docChildren.map((c) => className(c)), "→ offsets:", startRows);
	return startRows;
}

/**
 * Index of the user message currently at the top of the message flow: the
 * last user message starting above the viewport bottom; the first one when
 * the viewport is above all of them. -1 when there are no user messages.
 */
export function pickActiveIndex(startRows: number[], scrollTop: number, viewportHeight: number): number {
	if (startRows.length === 0) return -1;
	const bottom = scrollTop + viewportHeight;
	let active = -1;
	for (let i = 0; i < startRows.length; i++) {
		if (startRows[i] < bottom) active = i;
		else break; // rows are ascending
	}
	return active === -1 ? 0 : active;
}

/** How many markers the rail may show: half the viewport height, clamped. */
export function railCapacity(viewportHeight: number): number {
	return Math.max(3, Math.min(15, Math.floor(viewportHeight / 2)));
}

/**
 * Which marker indices to show. All of them when they fit, otherwise a
 * window of `capacity` indices centered on `active` (always containing it).
 */
export function windowIndices(count: number, active: number, capacity: number): number[] {
	if (count <= 0) return [];
	if (count <= capacity) return Array.from({ length: count }, (_, i) => i);
	const half = Math.floor((capacity - 1) / 2);
	const start = Math.max(0, Math.min(active - half, count - capacity));
	return Array.from({ length: capacity }, (_, i) => start + i);
}

// ---------------------------------------------------------------------------
// Rail installation (fullscreen layout-root wrapper)
// ---------------------------------------------------------------------------

/** Minimal structural theme surface used by the rail (live theme proxy). */
interface RailTheme {
	fg(color: string, text?: string): string;
}

const fallbackTheme: RailTheme = { fg: (_c, text) => text ?? "" };

export interface RailState {
	enabled: boolean;
	activeTui: TUI | null;
	transcript: ScrollView | null;
	getTheme: () => RailTheme;
	lastWidth: number;
	cacheKey: string | null;
	offsets: number[];
}

function isStopped(tui: TUI): boolean {
	try {
		return Boolean((tui as unknown as { stopped?: unknown }).stopped);
	} catch {
		return false;
	}
}

/**
 * Build a live theme reader for a session's ctx that survives session
 * replacement. The captured ctx goes stale the moment pi swaps sessions
 * (newSession / fork / switchSession / reload) — the old ctx's `ui` getter
 * then throws (ExtensionRunner.assertActive). TUI render frames can run
 * during that replacement window (before the replacement's session_start
 * re-captures a fresh ctx), and the rail composites markers on EVERY frame —
 * a throw there crashes the whole process (see crashes.json). So this getter
 * never throws: it falls back to the last successfully read theme
 * (fallbackTheme before the first read) and picks up live theme changes
 * again as soon as the ctx is active.
 */
function makeThemeReader(ctx: { ui: { theme: unknown } }): () => RailTheme {
	let last: RailTheme = fallbackTheme;
	return () => {
		try {
			last = ctx.ui.theme as unknown as RailTheme;
		} catch {
			// stale ctx (session replacement in flight): keep the last theme
		}
		return last;
	};
}

/**
 * Marker rail: one line per marker, composited onto the right side of the
 * rendered transcript document, vertically centered over the visible part
 * of the transcript viewport.
 */
export class MarkerRail {
	state: RailState;

	constructor(state: RailState) {
		this.state = state;
	}

	/** The document being measured (unwrap our own wrapper if present). */
	private unwrap(doc: unknown): unknown {
		return doc instanceof RailDocument ? doc.inner : doc;
	}

	/** Recompute user-message start rows when the document structure changed. */
	private refreshOffsets(width: number): number[] {
		const { transcript } = this.state;
		if (!transcript) return [];
		const doc = this.unwrap(transcript.child);
		const key = snapshotKey(doc, width);
		if (key !== this.state.cacheKey) {
			this.state.cacheKey = key;
			this.state.offsets = collectUserMessageOffsets(doc, width);
		}
		return this.state.offsets;
	}

	/** Composite the rail onto a freshly rendered document frame (mutates `lines`). */
	overlay(lines: string[], width: number): string[] {
		const { transcript, activeTui } = this.state;
		const now = Date.now();
		if (DEBUG_FILE && now - lastOverlayLog > 1500) {
			lastOverlayLog = now;
			dbg(
				"overlay:",
				{
					enabled: this.state.enabled,
					transcript: transcript ? className(transcript) : null,
					activeTui: activeTui ? className(activeTui) : null,
					stopped: activeTui ? isStopped(activeTui) : null,
					width,
					doc: transcript ? className(transcript.child) : null,
					docLines: lines.length,
				},
			);
		}
		if (!this.state.enabled || !transcript || !activeTui || isStopped(activeTui)) return lines;
		if (width < 8) return lines;
		this.state.lastWidth = width;
		const scrollTop = transcript.scrollTop;
		const vh = transcript.viewportHeight > 0 ? transcript.viewportHeight : lines.length;
		const rows = this.refreshOffsets(width);
		if (rows.length === 0) return lines;
		const active = pickActiveIndex(rows, scrollTop, vh);
		const window = windowIndices(rows.length, active, railCapacity(vh));
		const theme = this.state.getTheme();
		const marks: string[] = [];
		if (window[0] > 0) marks.push(theme.fg("dim", "… "));
		for (const idx of window) {
			marks.push(idx === active ? theme.fg("accent", "▸ ") : theme.fg("dim", "· "));
		}
		if (window[window.length - 1] < rows.length - 1) marks.push(theme.fg("dim", "… "));
		// Vertical centering within the visible viewport, mapped into document rows.
		const visibleHeight = Math.max(0, Math.min(vh, lines.length - scrollTop));
		const top = Math.max(0, Math.floor((visibleHeight - marks.length) / 2));
		const col = width - 2;
		for (let i = 0; i < marks.length; i++) {
			const docRow = scrollTop + top + i;
			if (docRow < 0 || docRow >= lines.length) continue;
			lines[docRow] = compositeTuiLine(lines[docRow], marks[i], col, 2, width);
		}
		return lines;
	}

	/** Scroll the transcript so the previous/next user message starts at the top. */
	jump(direction: -1 | 1): boolean {
		const { transcript, activeTui } = this.state;
		if (!this.state.enabled || !transcript || !activeTui || isStopped(activeTui)) return false;
		const width = this.state.lastWidth;
		if (width <= 0) return false;
		const vh = transcript.viewportHeight > 0 ? transcript.viewportHeight : 1;
		const rows = this.refreshOffsets(width);
		if (rows.length === 0) return false;
		const active = pickActiveIndex(rows, transcript.scrollTop, vh);
		const target =
			active === -1
				? direction > 0
					? 0
					: rows.length - 1
				: Math.max(0, Math.min(rows.length - 1, active + direction));
		transcript.scrollTo(rows[target], { disableFollow: true });
		activeTui.requestRender();
		return true;
	}
}

/**
 * Wraps the transcript document (the transcript ScrollView's child). The
 * layout system only descends through LAYOUT_NODE components and renders
 * every other component as a leaf — the original document is a plain
 * Container leaf, so replacing it with this same-shaped leaf keeps sizing,
 * wheel scrolling, the scrollbar, text selection and mouse dispatch 1:1.
 * The wrapper renders the document unchanged and composites the rail onto
 * the right edge, centered over the visible viewport.
 */
export class RailDocument implements Component {
	inner: Component;
	rail: MarkerRail;

	constructor(inner: Component, rail: MarkerRail) {
		this.inner = inner;
		this.rail = rail;
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		return this.rail.overlay(lines, width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		// The layout box of this wrapper has exactly the document's rect, so
		// event coordinates are valid for the wrapped document as-is.
		const fn = (this.inner as { handleMouse?: (e: TuiMouseEvent) => TuiMouseEventResult }).handleMouse;
		return typeof fn === "function" ? fn.call(this.inner, event) : undefined;
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

/** Structural snapshot (no rendering) used to invalidate the offset cache. */
const refIds = new WeakMap<object, number>();
let nextRefId = 1;
function refId(v: unknown): string {
	if (typeof v !== "object" || v === null) return String(v);
	let id = refIds.get(v as object);
	if (id === undefined) {
		id = nextRefId++;
		refIds.set(v as object, id);
	}
	return `r${id}`;
}

function snapshotKey(doc: unknown, width: number): string {
	const docChildren = childrenOf(doc);
	if (!docChildren) return `bad/${width}`;
	const parts: string[] = [String(width), refId(doc), String(docChildren.length)];
	let chatSig = "-";
	for (const child of docChildren) {
		const subs = childrenOf(child);
		if (subs && subs.some((s) => isUserMessageLike(s))) {
			chatSig = `${subs.length}|${refId(subs[subs.length - 1])}`;
			break;
		}
		parts.push(subs ? String(subs.length) : "0");
	}
	parts.push(chatSig);
	return parts.join("/");
}

function findTranscript(root: Component): ScrollView | null {
	const kids = childrenOf(root);
	if (!kids) return null;
	for (const k of kids) if (k instanceof ScrollView) return k;
	return null;
}

export function installRail(tui: TUI, state: RailState, rail: MarkerRail): void {
	if (!state.enabled) {
		dbg("installRail: skip (disabled)");
		return;
	}
	dbg("installRail:", {
		tui: className(tui),
		viewport: isViewportTUI(tui),
		mode: (tui as TUI).mode,
		stopped: isStopped(tui),
		layoutRoot: className((tui as unknown as { layoutRoot?: unknown }).layoutRoot),
		layoutRootChildren: childrenOf((tui as unknown as { layoutRoot?: unknown }).layoutRoot)?.map((c) => className(c)),
	});
	if (!isViewportTUI(tui) || tui.mode !== "fullscreen" || isStopped(tui)) {
		dbg("installRail: skip (not fullscreen viewport / stopped)");
		return;
	}
	const vp = tui as unknown as { layoutRoot?: Component };
	const root = vp.layoutRoot;
	if (!root) {
		dbg("installRail: skip (no layoutRoot)");
		return;
	}
	const transcript = findTranscript(root);
	if (!transcript) {
		dbg("installRail: skip (no transcript ScrollView)");
		return;
	}
	const doc = transcript.child;
	if (doc instanceof RailDocument) {
		// Already wrapped (duplicate install / re-bind): re-sync state.
		state.activeTui = tui;
		state.transcript = transcript;
		state.cacheKey = null;
		dbg("installRail: already wrapped, re-synced");
		return;
	}
	if (!doc) {
		dbg("installRail: skip (transcript has no child yet)");
		return;
	}
	state.activeTui = tui;
	state.transcript = transcript;
	state.cacheKey = null;
	state.offsets = [];
	transcript.child = new RailDocument(doc, rail);
	transcript.invalidate();
	tui.requestRender();
	dbg("installRail: WRAPPED document:", className(doc));
}

function uninstallRail(state: RailState): void {
	const tui = state.activeTui;
	const transcript = state.transcript;
	if (transcript && transcript.child instanceof RailDocument) {
		transcript.child = (transcript.child as RailDocument).inner;
		transcript.invalidate();
		if (tui && !isStopped(tui)) tui.requestRender();
		dbg("uninstallRail: document restored");
	}
	state.activeTui = null;
	state.transcript = null;
	state.cacheKey = null;
	state.offsets = [];
}

const START_PATCH_KEY = Symbol.for("pi.agent.messageMarkers.startPatch");

/**
 * One-time, idempotent patch: every newly started fullscreen TUI gets the
 * rail installed after start() (layoutRoot is set by the time start() runs).
 * Guarded on globalThis so /reload re-imports don't double-wrap.
 */
function patchAltScreenStart(onStart: (tui: TUI) => void): void {
	const g = globalThis as Record<PropertyKey, unknown>;
	if (g[START_PATCH_KEY]) return;
	const proto = TuiAltScreen.prototype as unknown as { start?: () => void };
	const parentProto = Object.getPrototypeOf(TuiAltScreen.prototype) as { start?: () => void };
	const orig = proto.start ?? parentProto?.start;
	if (typeof orig !== "function") {
		dbg("patch: no original start found, aborting");
		return;
	}
	proto.start = function (this: TUI) {
		dbg("patched start: tui class:", className(this));
		orig.call(this);
		try {
			setImmediate(() => {
				try {
					onStart(this);
				} catch (err) {
					dbg("patched start: install error:", err);
					// Never break the TUI because of the rail.
				}
			});
		} catch {
			// Never break the TUI because of the rail.
		}
	};
	g[START_PATCH_KEY] = true;
	dbg("patch: installed on TuiAltScreen.prototype.start");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

let testState: RailState | null = null;

/** Test-only: the RailState of the most recent default-export invocation. */
export function railStateForTests(): RailState {
	if (!testState) throw new Error("extension entry not loaded yet");
	return testState;
}

export default function (pi: ExtensionAPI): void {
	const state: RailState = {
		enabled: true,
		activeTui: null,
		transcript: null,
		getTheme: () => fallbackTheme,
		lastWidth: 0,
		cacheKey: null,
		offsets: [],
	};
	testState = state;
	const rail = new MarkerRail(state);

	// (a) Catch every newly started fullscreen TUI (mode switches, startup).
	patchAltScreenStart((tui) => installRail(tui, state, rail));

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		state.getTheme = makeThemeReader(ctx);
		if (!state.enabled) return;
		// (b) Capture the live TUI. Covers the initial TUI, which starts
		// before extensions load. done() is called synchronously in the
		// factory, so the component is never actually mounted (no flash).
		void ctx.ui.custom((tui, _theme, _keybindings, done) => {
			try {
				installRail(tui, state, rail);
			} catch (err) {
				dbg("session_start capture: install error:", err);
				// ignore — the rail must never break the session
			}
			done(undefined);
			return { render: () => [] as string[], invalidate: () => {} };
		});
		// Jump keys. onTerminalInput runs before the focused component and
		// pi re-binds these listeners to a new TUI on mode switches.
		ctx.ui.onTerminalInput((data) => {
			if (!state.enabled) return undefined;
			let direction: -1 | 1 | 0 = 0;
			if (matchesKey(data, "alt+up")) direction = -1;
			else if (matchesKey(data, "alt+down")) direction = 1;
			if (direction === 0) return undefined;
			if (rail.jump(direction)) return { consume: true };
			return undefined;
		});
	});

	pi.registerCommand("markers", {
		description: "Message marker rail (fullscreen): /markers [on|off|status]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (ctx.mode !== "tui") {
				ctx.ui.notify("message markers require interactive mode", "error");
				return;
			}
			if (arg === "off") {
				state.enabled = false;
				uninstallRail(state);
				ctx.ui.notify("message markers off", "info");
				return;
			}
			if (arg === "on") {
				state.enabled = true;
				state.getTheme = makeThemeReader(ctx);
				void ctx.ui.custom((tui, _theme, _keybindings, done) => {
					try {
						installRail(tui, state, rail);
					} catch {
						// ignore
					}
					done(undefined);
					return { render: () => [] as string[], invalidate: () => {} };
				});
				ctx.ui.notify("message markers on (fullscreen mode)", "info");
				return;
			}
			const n = state.offsets.length;
			ctx.ui.notify(
				`message markers ${state.enabled ? "on" : "off"} — ${n} user message${n === 1 ? "" : "s"} tracked`,
				"info",
			);
		},
	});
}
