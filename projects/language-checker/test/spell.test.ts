/**
 * TDD contract for the spell-check core (Step 1 — expected RED: spell.ts does not exist yet).
 *
 * Contract under test:
 *   checkWord(word, dict): boolean  →  true = "ok, do not flag", false = "misspelled, flag it"
 *
 * Heuristic skips (all return true):
 *   - empty or any apostrophe-segment with < 3 characters
 *   - words containing digits (code identifiers, version numbers)
 *   - ALL-CAPS words (acronyms: NPM, URLS, API)
 *   - words with an inner uppercase letter (camelCase identifiers)
 *   - words in IGNORE_WORDS (technical terms missing from the dictionary)
 * Lookup rules:
 *   - case-insensitive dictionary hit → true
 *   - trailing-'s' plural fallback (word-s in dict) → true
 *   - anything else → false (misspelled)
 *
 * Apostrophes: the word is split on "'"; the word is misspelled iff ANY segment is.
 *
 * Run: node --test /home/julian/.pi/agent/projects/language-checker/test/spell.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkWord, loadDictionary, IGNORE_WORDS } from "../../../extensions/language-checker/spell.ts";

// Hermetic synthetic dictionary — tests never depend on the real en-words.txt.
const DICT = new Set([
	"the", "receive", "word", "words", "don", "t", "roll", "rock", "smart", "phone",
]);

test("dictionary hit / miss", () => {
	assert.equal(checkWord("receive", DICT), true);
	assert.equal(checkWord("recieve", DICT), false);
	assert.equal(checkWord("thexyz", DICT), false);
});

test("case-insensitive lookup", () => {
	assert.equal(checkWord("Receive", DICT), true);
	assert.equal(checkWord("THE", DICT), true); // all-caps skip
});

test("short words are skipped", () => {
	assert.equal(checkWord("", DICT), true);
	assert.equal(checkWord("a", DICT), true);
	assert.equal(checkWord("xx", DICT), true);
	assert.equal(checkWord("zzz", DICT), false); // 3 chars is the minimum that gets checked
});

test("words containing digits are skipped (identifiers, versions)", () => {
	assert.equal(checkWord("abc123", DICT), true);
	assert.equal(checkWord("123", DICT), true);
	assert.equal(checkWord("ts5", DICT), true);
});

test("camelCase / inner-uppercase words are skipped", () => {
	assert.equal(checkWord("myVariable", DICT), true);
	assert.equal(checkWord("myRecieve", DICT), true); // inner uppercase → identifier, not flagged
	assert.equal(checkWord("RECEIVE", DICT), true); // all caps → acronym skip
});

test("apostrophes: split, word fails iff any segment fails", () => {
	assert.equal(checkWord("don't", DICT), true); // "don" in dict, "t" short
	assert.equal(checkWord("recieve's", DICT), false);
	assert.equal(checkWord("rock'n'roll", DICT), true);
	assert.equal(checkWord("'t", DICT), true);
});

test("trailing-'s' plural fallback", () => {
	assert.equal(checkWord("words", DICT), true); // "word" in dict
	assert.equal(checkWord("recieves", DICT), false); // stem "reciev" is NOT in dict
});

test("built-in ignore list covers common technical terms", () => {
	for (const w of ["npm", "json", "tsx", "jiti", "tui", "mcp"]) {
		assert.ok(IGNORE_WORDS.has(w), `expected "${w}" in IGNORE_WORDS`);
		assert.equal(checkWord(w, new Set<string>()), true, `checkWord("${w}", ∅) must be true`);
	}
});

test("loadDictionary: lowercases, trims, skips blank lines", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speldict-"));
	try {
		const file = path.join(dir, "words.txt");
		fs.writeFileSync(file, "  Alpha  \nBETA\n\n   \ngamma\n", "utf8");
		const dict = loadDictionary(file);
		assert.ok(dict.has("alpha"));
		assert.ok(dict.has("beta"));
		assert.ok(dict.has("gamma"));
		assert.equal(dict.has(""), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
