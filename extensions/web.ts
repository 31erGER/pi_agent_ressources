/**
 * web-tools extension for pi — web search + page reading.
 *
 *  - `search`: queries the LOCAL SearXNG instance (no external search provider).
 *  - `fetch`:  reads a specific http/https page DIRECTLY (no third-party
 *              proxy of any kind), converts HTML to plain text locally.
 *
 * Every tool result is the pi result object { content, details };
 * failures are returned with isError: true and never throw.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════
//  CONFIGURATION — adjust these to taste (they are used everywhere)
// ═══════════════════════════════════════════════════════════════

const SEARXNG_BASE_URL = "http://localhost:8080"; // SearXNG docker container
const SEARCH_MAX_RESULTS = 5;        // default number of results per search
const SEARCH_MAX_RESULTS_LIMIT = 10; // hard cap for the max_results parameter
const SEARCH_SNIPPET_CHARS = 300;    // snippet length per result

const FETCH_TIMEOUT_MS = 15000;  // abort page fetches after this many ms
const FETCH_MAX_CHARS = 20000;   // default AND hard cap for page text length
const FETCH_MIN_CHARS = 200;     // minimum allowed value for max_chars

// Categories enabled by the local SearXNG container (source of truth; verified via GET /config on 2026-11-09).
// Trim this list if you want to hide rarely-used categories from the model.
const SEARCH_CATEGORIES: string[] = [
    "general", "videos", "stock images", "other", "social media", "packages", "it", "files",
    "books", "news", "apps", "software wikis", "images", "science", "scientific publications", "music",
    "web", "repos", "currency", "icons", "weather", "map", "dictionaries", "shopping", "lyrics",
    "cargo", "movies", "translate", "radio", "blogs", "q&a", "wikimedia", "define",
];

const SEARCH_PAGE_MAX = 10; // hard cap for the page parameter (SearXNG pageno)

// ───────────────────────────────────────────────────────────────

type ResultDetails = Record<string, unknown>;

function textResult(text: string, details: ResultDetails) {
    return { content: [{ type: "text", text }], details };
}

function errorResult(text: string, details: ResultDetails = {}) {
    return { content: [{ type: "text", text }], details, isError: true };
}

const NAMED_ENTITIES: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»",
};

function decodeEntities(s: string): string {
    return s.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (match, body: string) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X"
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                ? String.fromCodePoint(code)
                : match;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    });
}

/** Dependency-free HTML → plain-text conversion (for LLM context, not rendering). */
function htmlToText(html: string): string {
    let text = html;
    // drop non-content blocks entirely
    text = text.replace(/<script[\s\S]*?<\/script\s*>/gi, " ");
    text = text.replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
    text = text.replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ");
    text = text.replace(/<!--[\s\S]*?-->/g, " ");
    // block boundaries → newlines, list items → bullets
    text = text.replace(/<li[^>]*>/gi, "\n• ");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(p|div|section|article|tr|table|h[1-6]|pre|blockquote|header|footer|nav|main|ul|ol)>/gi, "\n");
    // strip everything that is still a tag
    text = text.replace(/<[^>]*>/g, " ");
    text = decodeEntities(text);
    // normalize whitespace
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/ ?\n ?/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
}

/** Clamp a model-supplied integer into [min, max]; fall back to `def`. */
function clampParam(value: unknown, def: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(Math.round(n), min), max);
}

/** SearXNG time_range values (fixed by the API, not user-tunable). */
const SEARCH_FRESHNESS: string[] = ["day", "week", "month", "year"];

const searchTool = defineTool({
    name: "search",
    label: "Web Search",
    description:
        "Durchsucht das Web über die lokale SearXNG-Instanz nach aktuellen Informationen und Dokumentationen. " +
        "Liefert die Top-Ergebnisse mit Titel, URL und Snippet.",
    promptSnippet: "Search the web via the local SearXNG instance (titles, URLs, snippets)",
    promptGuidelines: [
        "Use search to look up current web information or documentation.",
        "Use search with max_results when fewer or more results are needed (max 10).",
        "Use search with freshness to look only for recent results (day, week, month, year), category to restrict the result type (e.g. it, news, images), language to pin the result language (e.g. de, en), and page (1–10) to paginate beyond the first result page.",
        "If a filtered search returns no results, retry with fewer filters: on this container, freshness only applies to a small set of engines per category (e.g. 'it' covers only hackernews, 'news' just two), so 0 results can mean that engine set simply had no hits — broaden the category or drop freshness.",
    ],
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "Suchbegriff" },
            max_results: {
                type: "integer",
                minimum: 1,
                maximum: SEARCH_MAX_RESULTS_LIMIT,
                description: `Anzahl der Ergebnisse (default ${SEARCH_MAX_RESULTS}, max ${SEARCH_MAX_RESULTS_LIMIT})`,
            },
            freshness: {
                type: "string",
                enum: SEARCH_FRESHNESS,
                description: "Zeitfenster der Ergebnisse (optional): day | week | month | year",
            },
            category: {
                type: "string",
                enum: SEARCH_CATEGORIES,
                description: "SearXNG-Kategorie zur Einschränkung des Ergebnis-Typs (optional)",
            },
            language: {
                type: "string",
                description: "Ergebnis-Sprache als Locale-Code (optional), z. B. 'de', 'en', 'en-US'",
            },
            page: {
                type: "integer",
                minimum: 1,
                maximum: SEARCH_PAGE_MAX,
                description: `Ergebnis-Seite zur Paginierung (optional, 1–${SEARCH_PAGE_MAX})`,
            },
        },
        required: ["query"],
    },

    execute: async (_toolCallId, params: any, signal?: AbortSignal) => {
        const query = String(params?.query ?? "").trim();
        if (!query) return errorResult("search: 'query' must be a non-empty string");
        const limit = clampParam(params?.max_results, SEARCH_MAX_RESULTS, 1, SEARCH_MAX_RESULTS_LIMIT);
        const freshness = params?.freshness != null && String(params.freshness).trim() !== ""
            ? String(params.freshness)
            : null;
        if (freshness !== null && !SEARCH_FRESHNESS.includes(freshness)) {
            return errorResult(`search: invalid 'freshness' '${freshness}' (allowed: ${SEARCH_FRESHNESS.join(", ")})`, { query });
        }
        const category = params?.category != null && String(params.category).trim() !== ""
            ? String(params.category)
            : null;
        if (category !== null && !SEARCH_CATEGORIES.includes(category)) {
            return errorResult(
                `search: invalid 'category' '${category}' — must be one of the ${SEARCH_CATEGORIES.length} enabled SearXNG categories (see the parameter schema)`,
                { query },
            );
        }
        const language = params?.language != null && String(params.language).trim() !== ""
            ? String(params.language).trim()
            : null;
        let page = null;
        if (params?.page != null) {
            const p = Number(params.page);
            if (!Number.isInteger(p) || p < 1 || p > SEARCH_PAGE_MAX) {
                return errorResult(`search: 'page' must be an integer between 1 and ${SEARCH_PAGE_MAX} (got ${params.page})`, { query });
            }
            page = p;
        }

        try {
            // Only set query params are appended — omitted optionals keep the request identical to before.
            const qp = new URLSearchParams();
            qp.set("q", query);
            qp.set("format", "json");
            if (freshness !== null) qp.set("time_range", freshness);
            if (category !== null) qp.set("categories", category);
            if (language !== null) qp.set("language", language);
            const pageno = page !== null && page > 1 ? page : null; // page 1 ≡ default request
            if (pageno !== null) qp.set("pageno", String(pageno));
            const url = `${SEARXNG_BASE_URL}/search?${qp.toString()}`;
            const res = await fetch(url, { signal, headers: { "user-agent": "pi-web-tools/1.0" } });
            if (!res.ok) {
                return errorResult(`search: SearXNG answered HTTP ${res.status} — is the container healthy at ${SEARXNG_BASE_URL}?`, { query });
            }
            const data = await res.json().catch(() => null);
            if (!data || !Array.isArray(data.results)) {
                return errorResult("search: unexpected SearXNG response (missing 'results' array)", { query });
            }

            const top = data.results.slice(0, limit).map((r: any) => ({
                title: (typeof r?.title === "string" && r.title.trim()) || "(untitled)",
                url: typeof r?.url === "string" ? r.url : "(no url)",
                snippet: typeof r?.content === "string"
                    ? r.content.replace(/\s+/g, " ").trim().slice(0, SEARCH_SNIPPET_CHARS)
                    : "",
            }));

            if (top.length === 0) {
                return textResult(`No SearXNG results for: ${query}`, { query, count: 0, time_range: freshness, categories: category, language, pageno });
            }
            const text = top
                .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
                .join("\n\n");
            return textResult(text, { query, count: top.length, time_range: freshness, categories: category, language, pageno });
        } catch (err: any) {
            return errorResult(`search: ${err?.message ?? err} — is the SearXNG docker container running at ${SEARXNG_BASE_URL}?`, { query });
        }
    },
});

const fetchTool = defineTool({
    name: "fetch",
    label: "Web Fetch",
    description:
        "Lädt den Textinhalt einer spezifischen http/https-URL direkt herunter (HTML wird lokal in Plain-Text umgewandelt). " +
        "Lange Seiten werden auf max_chars Zeichen gekürzt und können per offset in Stücken gelesen werden. " +
        "Mit raw=true wird der Körper unverändert zurückgegeben (z. B. für JSON-APIs).",
    promptSnippet: "Fetch a specific http/https URL directly and return its text content (HTML → plain text)",
    promptGuidelines: [
        "Use fetch to read the text content of a specific page URL.",
        "Use fetch with max_chars to limit output length for long pages (hard cap 20000).",
        "Use fetch with offset to continue reading a long page (the next offset is given in the truncation notice), and raw=true to get the unmodified body without HTML→text conversion (e.g. JSON APIs).",
    ],
    parameters: {
        type: "object",
        properties: {
            url: { type: "string", description: "Vollständige http/https URL" },
            max_chars: {
                type: "integer",
                minimum: FETCH_MIN_CHARS,
                description: `Maximal zurückzugebende Zeichen (default und Obergrenze ${FETCH_MAX_CHARS})`,
            },
            offset: {
                type: "integer",
                minimum: 0,
                description:
                    "Startposition in Zeichen zum Lesen langer Seiten in Stücken (default 0). " +
                    "Wenn die Seite gekürzt wird, erneut aufrufen mit offset=<returned_end> (steht in der Kürzungsnotiz).",
            },
            raw: {
                type: "boolean",
                description:
                    "true: Körper unverändert zurückgeben (keine HTML→Text-Umwandlung, keine Content-Type-Prüfung); " +
                    "max_chars und offset gelten trotzdem. Für JSON-APIs nützlich.",
            },
        },
        required: ["url"],
    },

    execute: async (_toolCallId, params: any, signal?: AbortSignal) => {
        const rawUrl = String(params?.url ?? "").trim();
        let parsed: URL;
        try {
            parsed = new URL(rawUrl);
        } catch {
            return errorResult("fetch: 'url' is not a valid URL");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return errorResult(`fetch: unsupported scheme '${parsed.protocol}' (only http/https allowed)`, { url: rawUrl });
        }

        const limit = clampParam(params?.max_chars, FETCH_MAX_CHARS, FETCH_MIN_CHARS, FETCH_MAX_CHARS);
        const rawMode = params?.raw === true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

        try {
            const res = await fetch(parsed.toString(), {
                signal: controller.signal,
                redirect: "follow",
                headers: { "user-agent": "Mozilla/5.0 (compatible; pi-web-tools/1.0)" },
            });
            if (!res.ok) {
                return errorResult(`fetch: HTTP ${res.status} ${res.statusText} for ${parsed.toString()}`, { url: rawUrl });
            }

            const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
            const raw = await res.text();
            const isHtml = contentType.includes("text/html") || contentType === "";
            const isTextual =
                rawMode || // raw mode returns the body unmodified, whatever the content type
                isHtml ||
                contentType.startsWith("text/") ||
                contentType.includes("json") ||
                contentType.includes("xml") ||
                contentType.includes("markdown");
            if (!isTextual) {
                return errorResult(`fetch: unsupported (binary) content type '${contentType}' — only text-based content is supported`, { url: rawUrl });
            }

            // Full conversion first, then slice the requested window [offset, offset + limit).
            const fullText = rawMode ? raw : isHtml ? htmlToText(raw) : raw.trim();
            const total = fullText.length;
            const offset = clampParam(params?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
            const rangeDetails = { url: rawUrl, offset, total_chars: total, contentType: contentType || "unknown" };

            if (total === 0) {
                return textResult(`[page has no text content (content-type: ${contentType || "unknown"})]`, {
                    ...rangeDetails,
                    returned_start: 0,
                    returned_end: 0,
                    has_more: false,
                    truncated: false,
                });
            }
            if (offset >= total) {
                return textResult(`[offset ${offset} is beyond end of page (${total} chars)]`, {
                    ...rangeDetails,
                    returned_start: total,
                    returned_end: total,
                    has_more: false,
                    truncated: false,
                });
            }

            const start = offset;
            const end = Math.min(start + limit, total);
            const hasMore = end < total;
            let text = fullText.slice(start, end);
            if (hasMore) {
                text +=
                    `\n\n[showing chars ${start}–${end} of ${total} — truncated, ` +
                    `refetch with offset=${end} for the next chunk (max_chars max ${FETCH_MAX_CHARS})]`;
            } else if (start > 0) {
                text += `\n\n[showing chars ${start}–${end} of ${total} — end of page]`;
            }
            return textResult(text, {
                ...rangeDetails,
                chars: text.length, // returned length incl. notice
                returned_start: start,
                returned_end: end,
                has_more: hasMore,
                truncated: hasMore,
            });
        } catch (err: any) {
            const reason = controller.signal.aborted
                ? `timed out after ${FETCH_TIMEOUT_MS} ms`
                : err?.message ?? String(err);
            return errorResult(`fetch: ${reason} for ${parsed.toString()}`, { url: rawUrl });
        } finally {
            clearTimeout(timer);
        }
    },
});

export default function webToolsExtension(pi: ExtensionAPI) {
    pi.registerTool(searchTool);
    pi.registerTool(fetchTool);
}
