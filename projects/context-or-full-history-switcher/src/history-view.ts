// history-view.ts — Pure display logic for the /history popup.
// No pi imports. Runs on Node 26 type-stripping.

// ──────────────────────────────────────────────
// Structural types matching session JSONL shapes
// ──────────────────────────────────────────────
export interface PlainEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface PlainMessageEntry extends PlainEntry {
  type: "message";
  message: {
    role: string;
    content: unknown;
  };
}

export interface PlainCompactionEntry extends PlainEntry {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface PlainBranchSummaryEntry extends PlainEntry {
  type: "branch_summary";
  fromId: string;
  summary: string;
}

export type HistoryView = "full" | "context";

export interface HistoryLine {
  text: string;
  color?: "dim" | "accent" | "success" | "warning" | "error";
}

// ──────────────────────────────────────────────
// clampScroll — scroll bounds helper
// ──────────────────────────────────────────────
export function clampScroll(
  scrollTop: number,
  delta: number,
  contentHeight: number,
  viewHeight: number,
): number {
  if (contentHeight <= 0 || viewHeight <= 0) return 0;
  const maxScroll = Math.max(0, contentHeight - viewHeight);
  return Math.max(0, Math.min(maxScroll, scrollTop + delta));
}

// ──────────────────────────────────────────────
// formatEntry — format a single entry → HistoryLine[]
// Every rendered entry's first line carries its UTC "HH:MM" timestamp.
// ──────────────────────────────────────────────
export function formatEntry(
  entry: PlainEntry,
  _view: HistoryView,
): HistoryLine[] {
  switch (entry.type) {
    case "message": {
      return formatMessage(entry as PlainMessageEntry);
    }
    case "compaction": {
      const e = entry as PlainCompactionEntry;
      return [{ text: `${stamp(e)} ⧉ Compaction: ${e.summary}`, color: "warning" }];
    }
    case "branch_summary": {
      const e = entry as PlainBranchSummaryEntry;
      return [{ text: `${stamp(e)} ⧉ Branch Summary: ${e.summary}`, color: "warning" }];
    }
    default:
      return []; // system, usage, custom, custom_message → skip
  }
}

// ──────────────────────────────────────────────
// stamp — UTC HH:MM for an entry timestamp
// ──────────────────────────────────────────────
function stamp(entry: PlainEntry): string {
  return entry.timestamp.slice(11, 16) || "--:--";
}

// ──────────────────────────────────────────────
// formatMessage — format one message entry
// ──────────────────────────────────────────────
function formatMessage(entry: PlainMessageEntry): HistoryLine[] {
  const role = entry.message.role;
  const content = entry.message.content;
  const ts = stamp(entry);

  switch (role) {
    case "user": {
      const text = extractText(content);
      if (!text) return [];
      const lines = text.split("\n");
      // First line: "HH:MM You: …" (accent); continuation lines plain.
      const out: HistoryLine[] = [{ text: `${ts} You: ${lines[0]}`, color: "accent" }];
      for (let i = 1; i < lines.length; i++) out.push({ text: lines[i] });
      return out;
    }
    case "assistant": {
      const body = formatAssistantContent(content);
      if (body.length === 0) return [];
      const first = body[0];
      if (first.text.startsWith("⚒ tool: ")) {
        // Entry starts with a tool call — no "Assistant:" label, keep dim color.
        first.text = `${ts} ${first.text}`;
      } else {
        // Entry starts with text — label it.
        first.text = `${ts} Assistant: ${first.text}`;
        delete first.color; // body text stays default
      }
      return body;
    }
    case "toolResult": {
      return formatToolResult(content, entry, ts);
    }
    default:
      return []; // system, bashExecution, custom, branchSummary, compactionSummary → skip
  }
}

// ──────────────────────────────────────────────
// formatAssistantContent — extract text blocks, tool calls, skip thinking
// ──────────────────────────────────────────────
function formatAssistantContent(content: unknown): HistoryLine[] {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const lines: HistoryLine[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    const type = b.type as string | undefined;

    if (type === "text" && typeof b.text === "string" && b.text) {
      for (const l of b.text.split("\n")) {
        if (l) lines.push({ text: l });
      }
    } else if (type === "toolCall" && typeof b.name === "string") {
      lines.push({ text: `⚒ tool: ${b.name}`, color: "dim" });
    }
    // Skip thinking blocks (type === "thinking")
  }
  return lines;
}

// ──────────────────────────────────────────────
// formatToolResult — collapse to summary line
// ──────────────────────────────────────────────
function formatToolResult(content: unknown, entry: PlainMessageEntry, ts: string): HistoryLine[] {
  const lineCount = countTextLines(content);
  const isError = (entry.message as Record<string, unknown>).isError === true;
  const status = isError ? "error" : "ok";
  const color = isError ? "error" : "dim";
  const plural = lineCount === 1 ? "line" : "lines";
  return [{ text: `${ts} ↳ ${status} · ${lineCount} ${plural}`, color }];
}

// ──────────────────────────────────────────────
// extractText — extract text from content (string or TextContent[])
// ──────────────────────────────────────────────
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null && "type" in block) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }
  return parts.join("");
}

// ──────────────────────────────────────────────
// countTextLines — count text lines in content
// ──────────────────────────────────────────────
function countTextLines(content: unknown): number {
  if (typeof content === "string") {
    return content ? content.split("\n").length : 0;
  }
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const block of content) {
    if (typeof block === "object" && block !== null && "type" in block) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        total += b.text.split("\n").length;
      }
    }
  }
  return total;
}

// ──────────────────────────────────────────────
// buildHistoryLines — main entry point
// ──────────────────────────────────────────────
export function buildHistoryLines(
  entries: PlainEntry[],
  view: HistoryView,
): HistoryLine[] {
  if (entries.length === 0) {
    return [{ text: "No messages in this view." }];
  }

  const lines: HistoryLine[] = [];
  let latestCompactionIndex = -1;

  // In full view, find the latest compaction to hide older ones
  if (view === "full") {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compaction") {
        latestCompactionIndex = i;
        break;
      }
    }
  }

  let rendered = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Skip older compaction entries when in full view
    if (view === "full" && entry.type === "compaction" && i !== latestCompactionIndex) {
      continue;
    }
    const formatted = formatEntry(entry, view);
    if (formatted.length === 0) continue; // skipped entries emit no blank line
    if (rendered) lines.push({ text: "" }); // one blank line between entries
    lines.push(...formatted);
    rendered = true;
  }
  return lines;
}
