/**
 * LM Studio provider: discovers chat models from a running LM Studio server
 * (default http://localhost:1234) so they appear in /model without a manual
 * models.json entry.
 *
 * - Model list comes from the native GET /api/v0/models endpoint (rich
 *   metadata: loaded state, context size). Falls back to the OpenAI-compatible
 *   GET /v1/models list when the native endpoint is unavailable.
 * - Chat models only: "llm" and "vlm" entries. Embedding and image-generation
 *   models are skipped.
 * - Context window: exact `loaded_context_length` for loaded models; for
 *   not-loaded models the model's max context clamped to
 *   $LM_STUDIO_CONTEXT_WINDOW (default 125000), since LM Studio loads
 *   on-demand at the context size configured in the app.
 * - Max output tokens: $LM_STUDIO_MAX_TOKENS (default 32768), clamped below
 *   the context window to prevent compaction/summarization truncation with
 *   thinking/reasoning models.
 * - Server URL: $LM_STUDIO_BASE_URL (default http://localhost:1234).
 *
 * /lmstudio re-reads the model list from the server at any time.
 *
 * Effort mapping (projects/lmstudio/efforts.json):
 *   Per-model map of pi thinking levels (off|minimal|low|medium|high|xhigh|max) to the
 *   `reasoning_effort` value sent in the request JSON. A default entry is auto-created
 *   for every newly loaded model; user edits win, missing levels are backfilled with
 *   the defaults, stale entries are kept, null disables a level. LM Studio 0.4.28
 *   supported values: none, minimal, low, medium, high, xhigh. Only applies to models
 *   detected as reasoning (thinkingLevelMap + supportsReasoningEffort); plain models
 *   never receive the field. Override the path via $LM_STUDIO_EFFORTS_FILE.
 *   Logic: projects/lmstudio/lmstudio-efforts.ts (unit-tested).
 */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { trackExtensionRun } from "./stats.ts"; // global usage counter (stats extension)
import { ensureModels, entryToThinkingLevelMap, effortsFileUrl } from "../projects/lmstudio/lmstudio-efforts.ts";
import type { EffortsFile } from "../projects/lmstudio/lmstudio-efforts.ts";

const PROVIDER_ID = "lmstudio";
const DEFAULT_BASE_URL = "http://localhost:1234";
const DEFAULT_CONTEXT_WINDOW = 125000;
const DEFAULT_MAX_TOKENS = 65536;
const STARTUP_TIMEOUT_MS = 3000;
const EFFORTS_URL = effortsFileUrl(import.meta.url); // projects/lmstudio/efforts.json (or $LM_STUDIO_EFFORTS_FILE)

const REASONING_MODEL_PATTERNS = [
  /qwen\s*3/i,
  /qwq/i,
  /deepseek-r1/i,
  /reasoning/i,
  /thinking/i,
];

interface LmStudioModel {
  id: string;
  type?: string; // "llm" | "vlm" | "embeddings" | ...
  publisher?: string; // "LLMs" | "Image" | "Embedding" | ...
  state?: string; // "loaded" | "not-loaded"
  max_context_length?: number;
  loaded_context_length?: number;
  capabilities?: string[];
}

function serverBase(): string {
  return (process.env.LM_STUDIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isReasoningModel(entry: LmStudioModel): boolean {
  if (entry.capabilities?.includes("reasoning") || entry.capabilities?.includes("thinking")) {
    return true;
  }
  return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(entry.id));
}

async function fetchCatalog(signal: AbortSignal): Promise<LmStudioModel[]> {
  const base = serverBase();
  try {
    const res = await fetch(`${base}/api/v0/models`, { signal });
    if (res.ok) {
      const payload = (await res.json()) as { data?: LmStudioModel[] };
      if (Array.isArray(payload.data)) return payload.data;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    if (signal.aborted) throw error;
    // Fallback: OpenAI-compatible list (no metadata).
    const res = await fetch(`${base}/v1/models`, { signal });
    if (!res.ok) {
      throw new Error(
        `LM Studio at ${base} is unreachable (HTTP ${res.status}). Is the server running?`,
      );
    }
    const payload = (await res.json()) as { data?: { id: string }[] };
    if (!Array.isArray(payload.data)) {
      throw new Error(`Unexpected response from ${base}/v1/models`);
    }
    return payload.data.filter((m) => typeof m.id === "string").map((m) => ({ id: m.id }));
  }
}

// OpenAI-compatible chat compat; reasoning models additionally get
// `reasoning_effort` support (values come from the efforts.json mapping).
const PLAIN_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
};
const REASONING_EFFORT_COMPAT = { ...PLAIN_COMPAT, supportsReasoningEffort: true };

function isChatModelEntry(entry: LmStudioModel): boolean {
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  const type = entry.type ?? "llm";
  if (type !== "llm" && type !== "vlm") return false; // skip embeddings & co.
  return entry.publisher !== "Image"; // skip image-generation models
}

function chatModelIds(catalog: LmStudioModel[]): string[] {
  return catalog.filter(isChatModelEntry).map((entry) => entry.id);
}

function toModelConfig(entry: LmStudioModel, efforts?: EffortsFile): ProviderModelConfig | null {
  if (!isChatModelEntry(entry)) return null;
  const type = entry.type ?? "llm";

  const loaded = entry.state === "loaded";
  let contextWindow: number;
  if (loaded && entry.loaded_context_length && entry.loaded_context_length > 0) {
    contextWindow = entry.loaded_context_length; // exact, measured
  } else {
    const cap = envInt("LM_STUDIO_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW);
    contextWindow = Math.min(entry.max_context_length ?? cap, cap);
  }
  const maxTokens = Math.min(envInt("LM_STUDIO_MAX_TOKENS", DEFAULT_MAX_TOKENS), contextWindow - 1);
  const reasoning = isReasoningModel(entry);

  return {
    id: entry.id,
    name: entry.id,
    reasoning,
    input: type === "vlm" ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: reasoning ? REASONING_EFFORT_COMPAT : PLAIN_COMPAT,
    // Reasoning models only: per-level `reasoning_effort` values from efforts.json
    // (missing/null level -> null -> level hidden from the UI, never sent).
    ...(reasoning ? { thinkingLevelMap: entryToThinkingLevelMap(efforts?.[entry.id]) } : {}),
  };
}

function toConfigs(catalog: LmStudioModel[], efforts: EffortsFile): ProviderModelConfig[] {
  return catalog
    .map((entry) => toModelConfig(entry, efforts))
    .filter((m): m is ProviderModelConfig => m !== null);
}

export default async (pi: ExtensionAPI) => {
  // Pre-fetch at startup so models are already listed when /model opens.
  // Non-fatal: if the server is down, refreshModels retries when /model opens.
  let initial: ProviderModelConfig[] = [];
  try {
    const signal = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
    const catalog = await fetchCatalog(signal);
    initial = toConfigs(catalog, await ensureModels(EFFORTS_URL, chatModelIds(catalog)));
  } catch {
    // leave empty; the picker refresh will retry
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "LM Studio",
    baseUrl: `${serverBase()}/v1`,
    apiKey: "lm-studio", // dummy key; LM Studio ignores it, but Pi needs resolvable auth
    api: "openai-completions",
    models: initial,
    refreshModels: async (context) => {
      if (!context.allowNetwork || context.signal.aborted) return initial;
      try {
        const catalog = await fetchCatalog(context.signal);
        if (context.signal.aborted) return initial;
        const refreshed = toConfigs(catalog, await ensureModels(EFFORTS_URL, chatModelIds(catalog)));
        return refreshed.length > 0 ? refreshed : initial;
      } catch {
        return initial; // keep the stale list rather than dropping models
      }
    },
  });

  pi.registerCommand("lmstudio", {
    description: "Re-read the model list from LM Studio",
    handler: async (_args, ctx) => {
      trackExtensionRun(import.meta.url); // /stats global usage counter
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const result = await ctx.modelRegistry.refresh({
          providers: [PROVIDER_ID],
          allowNetwork: true,
          force: true,
          signal: controller.signal,
        });
        const error = result.errors.get(PROVIDER_ID);
        if (error) {
          ctx.ui.notify(`LM Studio: ${error.message}`, "error");
          return;
        }
        const models = ctx.modelRegistry
          .getAvailable()
          .filter((m) => m.provider === PROVIDER_ID);
        ctx.ui.notify(
          models.length > 0
            ? `LM Studio: ${models.length} model(s) available — open /model to pick one`
            : "LM Studio: no chat models found",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `LM Studio refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  });
};
