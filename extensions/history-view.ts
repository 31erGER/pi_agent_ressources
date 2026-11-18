// history-view.ts — /history popup: view full conversation or context view
// in a scrollable overlay (zero session writes).
//
// Modeled on ~/.pi/agent/extensions/stats.ts StatsDashboard pattern.
// Pure display logic imported from the project's src/history-view.ts.

import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  KeybindingsManager,
  OverlayHandle,
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HistoryLine, HistoryView, PlainEntry } from "../projects/context-or-full-history-switcher/src/history-view.ts";
import { buildHistoryLines, clampScroll } from "../projects/context-or-full-history-switcher/src/history-view.ts";

// Theme token mapping for HistoryLine colors
const ROLE_TOKEN: Record<NonNullable<HistoryLine["color"]>, ThemeColor> = {
  accent: "accent",
  dim: "dim",
  success: "success",
  warning: "warning",
  error: "error",
};

// ──────────────────────────────────────────────
// HistoryViewer — scrollable overlay component
// ──────────────────────────────────────────────
export class HistoryViewer implements Component {
  private theme: Theme;
  private tui: TUI;
  private keybindings: KeybindingsManager;
  private done: () => void;
  private onRefresh: (() => void) | undefined;
  private handle: OverlayHandle | undefined;
  private scrollTop = 0;
  private cachedHeight = 0;
  private view: HistoryView;
  private cachedEntries: PlainEntry[];
  private wrapCache: { ref: PlainEntry[]; view: HistoryView; width: number; lines: HistoryLine[] } | undefined;

  constructor(
    theme: Theme,
    tui: TUI,
    keybindings: KeybindingsManager,
    view: HistoryView,
    entries: PlainEntry[],
    done: () => void,
    onRefresh?: () => void,
  ) {
    this.theme = theme;
    this.tui = tui;
    this.keybindings = keybindings;
    this.view = view;
    this.cachedEntries = entries;
    this.done = done;
    this.onRefresh = onRefresh;
  }

  setHandle(handle: OverlayHandle): void {
    this.handle = handle;
  }

  /** Replace the entry list and repaint (for live updates). */
  setEntries(entries: PlainEntry[]): void {
    this.cachedEntries = entries;
    this.invalidate();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.wrapCache = undefined;
  }

  /** Logical lines → word-wrapped lines that fit the inner box width.
   *  Cached by (entries ref, view, width) — scrolling re-slices without
   *  re-wrapping; width/entries changes re-wrap once. */
  private getWrappedLines(inner: number): HistoryLine[] {
    const c = this.wrapCache;
    if (c && c.ref === this.cachedEntries && c.view === this.view && c.width === inner) {
      return c.lines;
    }
    const logical = buildHistoryLines(this.cachedEntries, this.view);
    const lines: HistoryLine[] = [];
    for (const l of logical) {
      if (l.text === "") {
        lines.push(l); // blank separator stays a single line
        continue;
      }
      for (const wl of wrapTextWithAnsi(l.text, inner)) {
        lines.push({ text: wl, color: l.color });
      }
    }
    this.wrapCache = { ref: this.cachedEntries, view: this.view, width: inner, lines };
    return lines;
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.cancel") || data === "q" || data === "Q") {
      this.done();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      this.scrollBy(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.scrollBy(1);
      return;
    }
    if (kb.matches(data, "tui.select.pageUp")) {
      this.scrollBy(-this.pageSize());
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.scrollBy(this.pageSize());
      return;
    }
    // Raw SGR mouse sequences (regular mode wheel passthrough)
    const sgr = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
    if (sgr) {
      const button = Number(sgr[1]);
      if (button === 64) this.scrollBy(-1);
      else if (button === 65) this.scrollBy(1);
      return;
    }
    if (data === "r" || data === "R") {
      this.onRefresh?.();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    return { handled: true, render: this.scrollBy(event.wheelDelta) };
  }

  dispose(): void {
    // nothing to release
  }

  /** Content rows inside the box. The box is 7 chrome lines total (2 borders +
   *  header + header divider + footer divider + footer), so the content budget
   *  is the 88% overlay budget minus 7 — the box never exceeds maxHeight. */
  private contentHeight(): number {
    const rows = this.tui.terminal?.rows ?? 24;
    return Math.max(4, Math.floor((rows * 88) / 100) - 7);
  }

  private pageSize(): number {
    return this.contentHeight();
  }

  private scrollBy(delta: number): boolean {
    const viewH = this.contentHeight();
    if (viewH <= 0 || this.cachedHeight === 0) return false;
    const next = clampScroll(this.scrollTop, delta, this.cachedHeight, viewH);
    if (next === this.scrollTop) return false;
    this.scrollTop = next;
    return true;
  }

  private styleLine(line: HistoryLine): string {
    return line.color ? this.theme.fg(ROLE_TOKEN[line.color], line.text) : line.text;
  }

  render(width: number): string[] {
    const inner = Math.max(4, width - 4);
    const lines = this.getWrappedLines(inner);
    this.cachedHeight = lines.length;

    const viewH = this.contentHeight();
    this.scrollTop = Math.min(this.scrollTop, Math.max(0, lines.length - viewH));
    const visible = lines.slice(this.scrollTop, this.scrollTop + viewH);

    const modeLabel = this.view === "full" ? "full conversation" : "compact context";
    const pos = lines.length === 0 ? "0 lines" : `line ${this.scrollTop + 1}–${this.scrollTop + visible.length} of ${lines.length}`;
    const header = `history · ${modeLabel} · ${pos}`;
    const footer = "q/esc close   ·   ↑↓ pgup/pgdn/wheel scroll   ·   r refresh";
    const hline = (left: string, mid: string, right: string): string =>
      this.theme.fg("dim", `${left}${"─".repeat(inner)}${right}`);

    // pad=true: every row is exactly `inner` visible columns, so the right
    // border aligns even on blank separator lines.
    const cell = (text: string): string => truncateToWidth(text, inner, "…", true);

    const out: string[] = [];
    out.push(hline("╭", "", "╮"));
    out.push(`│ ${this.theme.fg("accent", cell(header))} │`);
    out.push(hline("├", "", "┤"));
    for (const line of visible) {
      out.push(`│ ${cell(this.styleLine(line))} │`);
    }
    out.push(hline("├", "", "┤"));
    out.push(`│ ${this.theme.fg("dim", cell(footer))} │`);
    out.push(hline("╰", "", "╯"));
    return out;
  }
}

// ──────────────────────────────────────────────
// Command
// ──────────────────────────────────────────────
const REFRESH_THROTTLE_MS = 250;

export default function (pi: ExtensionAPI): void {
  let lastView: HistoryView = "full";

  pi.registerCommand("history", {
    description: "Open a popup showing the full conversation or the context view (compact)",
    getArgumentCompletions: (prefix: string) => {
      const items = [{ value: "full", label: "full" }, { value: "context", label: "context" }];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/history needs the interactive TUI", "warning");
        return;
      }

      // Determine view mode: bare /history reopens the last-used view (default full)
      const arg = args?.toLowerCase().trim();
      const view: HistoryView = arg === undefined || arg === "" ? lastView : arg === "context" ? "context" : "full";
      lastView = view;

      // Collect entries
      const entries =
        view === "full"
          ? ctx.sessionManager.getBranch()
          : ctx.sessionManager.buildContextEntries();

      let comp: HistoryViewer | undefined;
      let lastRefreshAt = 0;
      let lastEntries: PlainEntry[] = entries;

      const refresh = (): void => {
        const now = Date.now();
        if (now - lastRefreshAt < REFRESH_THROTTLE_MS) return;
        lastRefreshAt = now;
        const newEntries =
          view === "full"
            ? ctx.sessionManager.getBranch()
            : ctx.sessionManager.buildContextEntries();
        if (newEntries !== lastEntries) {
          lastEntries = newEntries;
          comp?.setEntries(newEntries);
        }
      };

      // Live updates while overlay open
      const subs: (() => void)[] = [
        pi.on("message_update", refresh),
        pi.on("turn_start", refresh),
        pi.on("turn_end", refresh),
        pi.on("agent_start", refresh),
        pi.on("agent_end", refresh),
        pi.on("session_compact", refresh),
        pi.on("session_info_changed", refresh),
      ];

      try {
        await ctx.ui.custom<undefined>(
          (tui, theme, keybindings, done) => {
            comp = new HistoryViewer(theme, tui, keybindings, view, entries, () => done(undefined), refresh);
            return comp;
          },
          {
            overlay: true,
            overlayOptions: { width: "92%", maxHeight: "88%", anchor: "center", margin: 1 },
            onHandle: (handle) => {
              comp?.setHandle(handle);
            },
          },
        );
      } finally {
        for (const unsub of subs) {
          try {
            unsub();
          } catch {
            // non-fatal
          }
        }
        comp = undefined;
      }
    },
  });
}
