/**
 * spell.ts — pure spell-check core for the language-checker extension.
 *
 * No imports from pi/pi-tui (kept dependency-free so it can be unit-tested
 * with plain `node --test`). Only node built-ins.
 *
 * Contract (see projects/language-checker/test/spell.test.ts):
 *   checkWord(word, dict): boolean → true = ok/skip, false = misspelled.
 */
import fs from "node:fs";

/**
 * Technical terms that legitimately appear in coding prompts but are often
 * missing from plain English word lists. Case-insensitive.
 */
export const IGNORE_WORDS: ReadonlySet<string> = new Set([
	// package managers / runtimes / tooling
	"npm", "npx", "yarn", "pnpm", "bun", "deno", "uv", "pipx", "pipenv", "poetry",
	"conda", "venv", "pyenv", "jiti", "esbuild", "vite", "vitest", "jest",
	"eslint", "prettier", "webpack", "rollup", "tsup", "cmake", "makefile",
	// languages / file formats
	"js", "ts", "jsx", "tsx", "mjs", "cjs", "json", "jsonc", "yaml", "yml",
	"toml", "xml", "html", "css", "scss", "csv", "ini", "env", "regex", "lua",
	"rust", "golang", "kotlin", "swift", "docker", "kubernetes", "k8s",
	// web / networking
	"url", "uri", "api", "apis", "cli", "ide", "sdk", "tui", "gui", "ui", "ux",
	"esm", "wasm", "ansi", "utf", "utf8", "utf16", "rgb", "hex", "oauth", "jwt",
	"cors", "csrf", "http", "https", "localhost", "mcp", "rpc", "grpc",
	"webhook", "websocket", "http2",
	// ai / models / hardware
	"llm", "ollama", "lmstudio", "vllm", "sglang", "cuda", "cudnn", "nvidia",
	"intel", "amd", "raspberry", "gpt", "claude", "gemini", "qwen", "deepseek",
	"mistral", "llama", "embedding", "embeddings", "tokenize", "tokenizer",
	"quantized", "quantization", "kv", "rms", "layernorm", "backprop",
	// os / shells / editors / misc
	"sudo", "bash", "zsh", "fish", "nix", "homebrew", "brew", "apt", "dpkg",
	"pacman", "aur", "proot", "termux", "tmux", "zellij", "neovim", "vim",
	"emacs", "sublime", "vscode", "webkit", "chromium", "firefox", "safari",
	"curl", "wget", "ffmpeg", "git", "github", "gitlab", "sqlite", "postgres",
	"mysql", "mongodb", "redis", "kafka", "emoji", "unicode", "nodejs",
	"anthropic", "openai", "copilot", "codeium", "deepdive", "selfhosted",
	"crossplatform", "headless", "nohup", "stdin", "stdout", "stderr",
]);

/**
 * True = word is ok (in dictionary, ignored, or skipped by heuristic).
 * False = word should be flagged as misspelled.
 */
export function checkWord(word: string, dict: Set<string>): boolean {
	const raw = word.trim();
	if (raw === "") return true;
	// Code identifiers, version numbers, anything with digits → skip.
	if (/\d/.test(raw)) return true;
	// Contractions/possessives: word is misspelled iff ANY apostrophe-segment is.
	const segments = raw.split("'");
	for (const seg of segments) {
		if (!segmentOk(seg, dict)) return false;
	}
	return true;
}

function segmentOk(seg: string, dict: Set<string>): boolean {
	// Too short to be meaningful (a, x, t, …).
	if (seg.length < 3) return true;
	// ALL-CAPS → acronym (NPM, URLS, API).
	if (seg === seg.toUpperCase()) return true;
	// Inner uppercase → identifier / camelCase (myVariable, iPhone).
	if (/[A-Z]/.test(seg.slice(1))) return true;

	const lower = seg.toLowerCase();
	if (IGNORE_WORDS.has(lower)) return true;
	if (dict.has(lower)) return true;
	// Plural fallback: "words" → "word".
	if (lower.endsWith("s") && dict.has(lower.slice(0, -1))) return true;
	return false;
}

/**
 * Load a plain-text dictionary (one word per line) into a lowercased Set.
 * Words shorter than 3 characters are dropped (checkWord never needs them).
 */
export function loadDictionary(path: string): Set<string> {
	const text = fs.readFileSync(path, "utf8");
	const dict = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const w = line.trim().toLowerCase();
		if (w.length >= 3) dict.add(w);
	}
	return dict;
}
