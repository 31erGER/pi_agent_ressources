/**
 * TDD contract for the SGR-aware line restyler (Step 3 — expected RED: highlight.ts does not exist yet).
 *
 * Contract under test:
 *   styleLine(line, isMisspelled): string
 *     - `line` is one rendered editor line (may contain ANSI: SGR, CSI, OSC, CURSOR_MARKER)
 *     - `isMisspelled(word)` — heuristic lives in spell.ts; the restyler only asks
 *     - misspelled word tokens are wrapped:  \x1b[31;4m<word><restore>
 *     - <restore> re-applies the fg in effect at word start (or \x1b[39m if none) + \x1b[24m
 *     - visible text is NEVER changed (invariant); all sequences pass through
 *     - cursor handling: the editor renders the cursor cell as
 *       [CURSOR_MARKER] FAKE_CURSOR_START grapheme FAKE_CURSOR_END
 *       (markers hardcoded below). If the grapheme under the cursor is a
 *       letter, the word is split across the span and the fragments directly
 *       touching the span are NOT restyled; on a non-letter grapheme
 *       (word boundary) adjacent words are intact and styled normally.
 *
 * Run: node --test /home/julian/.pi/agent/projects/language-checker/test/highlight.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { styleLine } from "../../../extensions/language-checker/highlight.ts";

// Same constants as pi-tui (release 1.5.2, dist/tui.js) — hardcoded here so
// the test has no bare-specifier imports:
//   export const CURSOR_MARKER = "\x1b_pi:c\x07";
//   export const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
//   export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
const CURSOR = "\x1b_pi:c\x07";
const FC_START = "\x1b_pi:fc\x07";
const FC_END = "\x1b_pi:/fc\x07";
const RED_UL = "\x1b[31;4m";
const UL_OFF = "\x1b[24m";
const FG_DEFAULT = "\x1b[39m";

const stub = (word: string) => word === "recieve" || word === "transporth";

// Strict stub: flags every unknown word of length >= 3. Used for the cursor
// split tests so that a broken fragment-skip would actually be detected.
const KNOWN = new Set(["please", "ok", "the", "package", "more", "hello", "world", "bold", "plain", "foo", "tail", "end"]);
const stubAny = (word: string) => word.length >= 3 && !KNOWN.has(word);

/** Strip all ESC sequences (CSI / OSC / 2-byte) for visible-text comparison. */
function visible(s: string): string {
	return s
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
		.replace(/\x1b[@-Z\\-_]/g, "");
}

test("styles a misspelled word in a plain line", () => {
	const out = styleLine("please recieve the package", stub);
	assert.equal(out, `please ${RED_UL}recieve${FG_DEFAULT}${UL_OFF} the package`);
});

test("returns the line unchanged when nothing is misspelled", () => {
	const line = "please receive the package";
	assert.equal(styleLine(line, stub), line);
});

test("styles multiple words in one line", () => {
	const out = styleLine("recieve transporth ok", stub);
	assert.equal(
		out,
		`${RED_UL}recieve${FG_DEFAULT}${UL_OFF} ${RED_UL}transporth${FG_DEFAULT}${UL_OFF} ok`,
	);
});

test("styles a word at the very end of the line", () => {
	assert.equal(styleLine("tail recieve", stub), `tail ${RED_UL}recieve${FG_DEFAULT}${UL_OFF}`);
});

test("restores the explicit fg that was in effect at word start", () => {
	const line = "\x1b[38;5;15mhello recieve";
	const out = styleLine(line, stub);
	assert.equal(out, `\x1b[38;5;15mhello ${RED_UL}recieve\x1b[38;5;15m${UL_OFF}`);
});

test("keeps non-SGR CSI sequences intact", () => {
	const line = "\x1b[2Kfoo recieve";
	const out = styleLine(line, stub);
	assert.equal(out, `\x1b[2Kfoo ${RED_UL}recieve${FG_DEFAULT}${UL_OFF}`);
	assert.equal(visible(out), "foo recieve");
});

test("CURSOR_MARKER passes through untouched", () => {
	const line = "a \x1b_pi:c\x07b recieve";
	const out = styleLine(line, stub);
	assert.equal(out, `a ${CURSOR}b ${RED_UL}recieve${FG_DEFAULT}${UL_OFF}`);
});

test("word under the cursor (marker before first char) is NOT restyled", () => {
	const line = "\x1b_pi:c\x07recieve";
	assert.equal(styleLine(line, stub), line);
});

test("word with cursor on its last char is NOT restyled", () => {
	const line = "reciev\x1b_pi:c\x07e";
	assert.equal(styleLine(line, stub), line);
});

test("cursor right AFTER the word is fine — word still styled", () => {
	const line = "recieve\x1b_pi:c\x07 more";
	const out = styleLine(line, stub);
	assert.equal(out, `${RED_UL}recieve${FG_DEFAULT}${UL_OFF}${CURSOR} more`);
});

test("focused cursor splitting a word: fragments are NOT restyled", () => {
	// Real layout: before + CURSOR_MARKER + FC_START + grapheme + FC_END + rest
	const line = `reci${CURSOR}${FC_START}v${FC_END}e please`;
	assert.equal(styleLine(line, stubAny), line);
});

test("unfocused cursor over first char: suffix fragment NOT restyled", () => {
	// No CURSOR_MARKER while unfocused; only the fake-cursor pair.
	const line = `${FC_START}r${FC_END}ecieve please`;
	assert.equal(styleLine(line, stubAny), line);
});

test("focused cursor over the space after a word: word still styled", () => {
	const line = `recieve${CURSOR}${FC_START} ${FC_END} more`;
	assert.equal(
		styleLine(line, stub),
		`${RED_UL}recieve${FG_DEFAULT}${UL_OFF}${CURSOR}${FC_START} ${FC_END} more`,
	);
});

test("misspelled word separated from the cursor by a space is styled", () => {
	const line = `recieve ${FC_START}x${FC_END} ok`;
	assert.equal(styleLine(line, stub), `${RED_UL}recieve${FG_DEFAULT}${UL_OFF} ${FC_START}x${FC_END} ok`);
});

test("bold attribute survives around a styled word", () => {
	const line = "\x1b[1mrecieve \x1b[0mplain";
	const out = styleLine(line, stub);
	// bold (1) was in effect; only fg must be restored, bold reset comes from the original \x1b[0m
	assert.equal(out, `\x1b[1m${RED_UL}recieve\x1b[39m${UL_OFF} \x1b[0mplain`);
});

test("invariant: visible text never changes", () => {
	const cases = [
		"plain recieve text",
		"\x1b[38;2;220;50;47mstyled recieve \x1b[1mbold",
		"a \x1b_pi:c\x07b recieve",
		"recieve's transporth ok",
		"",
		"\x1b[2K\x1b[0m",
	];
	for (const line of cases) {
		assert.equal(visible(styleLine(line, stub)), visible(line), `visible text changed for: ${JSON.stringify(line)}`);
	}
});

test("lines without letters are returned as-is (fast path)", () => {
	const line = "\x1b[31m---\x1b[0m 123";
	assert.equal(styleLine(line, stub), line);
});
