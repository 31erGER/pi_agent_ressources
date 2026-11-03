/**
 * Session name in the chat input's top border + nameless built-in footer.
 *
 * Two related display behaviors in ONE file, so deleting this single file
 * restores pi's original look and feel:
 *
 *  1. TOP BORDER (right side of the colored line):
 *         ─────── ~/some/path • my session name ───────
 *     Path with `~` abbreviation (same logic as the original footer), name
 *     part capped at 70 visible columns; the label is "stuck to the left" —
 *     the beginning is always shown, only the right end gets `...`.
 *
 *  2. FOOTER: the original built-in footer, byte-identical — except the
 *     `• <session name>` suffix is removed from its first (path/branch)
 *     line, because the name is already shown in the top border:
 *         ~/some/path (branch)
 *         ↑12.3k ↓1.8k R9.8k W2.3k CH60% $0.12 CTX34%(auto)  model  2providers
 *
 *     Implemented by wrapping pi's real FooterComponent (exported from the
 *     package root) with a session shim that masks
 *     sessionManager.getSessionName() — so the path line, token stats,
 *     context usage, model info and extension-status lines stay in lockstep
 *     with pi's built-in footer (including future pi footer updates).
 *
 * Pure display: does not touch session files and does not enter the LLM
 * context. Non-TUI modes are unaffected (setEditorComponent / setFooter are
 * no-ops outside the TUI).
 */

import path from "node:path";
import {
    FooterComponent,
    type AgentSession,
    CustomEditor,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    sliceByColumn,
    stripTerminalSequences,
    visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_NAME_WIDTH = 70;
const ELLIPSIS = "...";
const DASH = "─";

/**
 * Same `~` abbreviation as the built-in footer (formatCwdForFooter in
 * dist/modes/interactive/components/footer.js, not exported from the root):
 * home prefix becomes `~`, paths outside home stay raw.
 */
function formatCwd(cwd: string, home: string | undefined): string {
    if (!home) return cwd;
    const rel = path.relative(path.resolve(home), path.resolve(cwd));
    if (rel === "") return "~";
    if (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
        return `~${path.sep}${rel}`;
    }
    return cwd;
}

/**
 * Keep the beginning of the name ("stuck to the left"); when the name
 * exceeds MAX_NAME_WIDTH visible columns, keep the first 70 and append `...`.
 */
function capName(name: string): string {
    // If the name is wider than the cap, the 70-column slice is always a
    // proper prefix (some visible content lies beyond column 70), so the
    // truncation dots are always appended.
    if (visibleWidth(name) <= MAX_NAME_WIDTH) return name;
    return sliceByColumn(name, 0, MAX_NAME_WIDTH) + ELLIPSIS;
}

/**
 * Splice `label` into the trailing run of border dashes of a single-line
 * (possibly ANSI-colored) border, right-anchored: `<filler>─ <label> ─`.
 * The label text itself is left-anchored: when the label is wider than the
 * available run it is re-truncated from the right (`...`), so the beginning
 * (path, then name start) is never the part that gets cut. Returns the
 * original line when there is no room at all.
 */
function appendSessionName(
    borderLine: string,
    label: string,
    borderColor: (text: string) => string,
): string {
    const text = stripTerminalSequences(borderLine);
    const width = visibleWidth(text);

    // The trailing run of border dashes (all top-border variants end in one).
    let runStart = width;
    while (runStart > 0 && text[runStart - 1] === DASH) runStart--;
    const trailing = width - runStart;
    if (trailing === 0) return borderLine;

    let outLabel = label;
    const budget = trailing - 3; // 2 padding spaces + 1 closing dash
    if (budget <= 0) return borderLine; // no room at all
    if (visibleWidth(outLabel) > budget) {
        // Left-anchored: keep the beginning, truncate only the right end.
        outLabel =
            budget >= 4
                ? sliceByColumn(label, 0, budget - ELLIPSIS.length) + ELLIPSIS
                : sliceByColumn(label, 0, budget); // no room for dots: as much as fits
    }

    const fill = trailing - visibleWidth(outLabel) - 3;
    const prefix = sliceByColumn(borderLine, 0, runStart);
    // One single colored segment for the spliced tail, like the plain border.
    return `${prefix}${borderColor(`${DASH.repeat(fill)} ${outLabel} ${DASH}`)}`;
}

/**
 * The border extension: same as pi's editor, but the top border shows the
 * path + session name on the right.
 */
class SessionNameEditor extends CustomEditor {
    constructor(
        tui: ConstructorParameters<typeof CustomEditor>[0],
        theme: ConstructorParameters<typeof CustomEditor>[1],
        keybindings: ConstructorParameters<typeof CustomEditor>[2],
        private readonly getLabel: () => string,
    ) {
        super(tui, theme, keybindings, { embedWorkingStatus: true });
    }

    override render(width: number): string[] {
        const lines = super.render(width);
        const label = this.getLabel();
        if (visibleWidth(label) > 0 && lines.length > 0) {
            lines[0] = appendSessionName(lines[0], label, this.borderColor);
        }
        return lines;
    }
}

/**
 * Session shim for the footer: satisfies everything FooterComponent reads,
 * with live getters (values are resolved at call time, so model switches
 * etc. are picked up), and masks sessionManager.getSessionName() so the
 * footer's first line never shows the `• <session name>` suffix.
 *
 * Not available to extensions (so the shim omits them, with graceful
 * fallbacks inside the footer): `routedModel` (virtual-model routing
 * indicator) and `modelRuntime` (subscription indicator).
 */
function createNamelessSession(ctx: ExtensionContext): AgentSession {
    const maskedSessionManager = new Proxy(ctx.sessionManager as object, {
        get(target, prop) {
            if (prop === "getSessionName") return () => undefined;
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    const shim = {
        get state() {
            return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
        },
        get model() {
            return ctx.model;
        },
        get routedModel() {
            return undefined;
        },
        modelRuntime: {
            isUsingSubscription: (_provider: string) => false,
        },
        getContextUsage: () => ctx.getContextUsage(),
        sessionManager: maskedSessionManager,
    };
    return shim as unknown as AgentSession;
}

/**
 * The built-in FooterComponent with the session name hidden. Delegates all
 * rendering to the real component, so output is identical to the default
 * footer apart from the name suffix. If a future pi version changes the
 * footer internals in a way the shim cannot satisfy, degrade to the last
 * good frame instead of throwing into the TUI render loop.
 */
class NamelessFooter {
    private readonly inner: FooterComponent;
    private lastLines: string[] = [];

    constructor(inner: FooterComponent) {
        this.inner = inner;
    }

    render(width: number): string[] {
        try {
            this.lastLines = this.inner.render(width);
        } catch {
            // keep last good frame
        }
        return this.lastLines;
    }

    invalidate(): void {
        this.inner.invalidate();
    }

    dispose(): void {
        this.inner.dispose();
    }
}

export default function sessionNameBorder(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        // 1) Top border: path + name on the right.
        const home = process.env.HOME ?? process.env.USERPROFILE;
        const getLabel = () => {
            const cwd = formatCwd(ctx.sessionManager.getCwd(), home);
            const name = (ctx.sessionManager.getSessionName() ?? "").trim();
            return name ? `${cwd} • ${capName(name)}` : cwd;
        };
        ctx.ui.setEditorComponent(
            (tui, theme, keybindings) =>
                new SessionNameEditor(tui, theme, keybindings, getLabel),
        );

        // 2) Footer: the original built-in footer without the `• name` suffix.
        ctx.ui.setFooter((_tui, _theme, footerData) =>
            new NamelessFooter(
                new FooterComponent(createNamelessSession(ctx), footerData),
            ),
        );
    });
}
