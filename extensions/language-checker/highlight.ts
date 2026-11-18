/**
 * Line-level styling for the pi TUI editor: wrap misspelled words in
 * red + underline, restoring the surrounding SGR state.
 *
 * Contract (see test/highlight.test.ts):
 * - The visible text (all non-ANSI characters) is never changed, reordered
 *   or dropped. Only escape sequences are inserted.
 * - Misspelled word tokens are wrapped in `\x1b[31;4m<word><restore>` where
 *   <restore> re-applies the foreground color in effect at the word start
 *   (`\x1b[39m` if none) and turns underline off (`\x1b[24m`).
 * - All non-SGR escape sequences (CSI like \x1b[2K, OSC, 2-byte) pass
 *   through untouched. SGR sequences are re-emitted unchanged.
 * - Cursor region handling. The real editor renders the cursor cell as
 *   `before + [CURSOR_MARKER] + FAKE_CURSOR_START + grapheme +
 *   FAKE_CURSOR_END + rest` (pi-tui tui.js / components/editor.js, release
 *   1.5.2; CURSOR_MARKER is emitted only while focused). If the grapheme
 *   under the cursor is a letter, the word is SPLIT across the span, so the
 *   fragments directly touching the span must not be flagged. If the
 *   grapheme is not a letter (cursor on a word boundary), the adjacent
 *   words are intact and are styled normally. A bare CURSOR_MARKER without
 *   a fake-cursor pair (defensive; not produced by the real editor) uses
 *   the character immediately after the marker the same way.
 * - A line without letters is returned unchanged (fast path).
 *
 * The marker constants are hardcoded (not imported from pi-tui) so this
 * module stays dependency-light. If pi changes them, the tests encode the
 * expected values and will fail loudly.
 */

const CURSOR_MARKER = "\u001B_pi:c\u0007";
const FAKE_CURSOR_START = "\u001B_pi:fc\u0007";
const FAKE_CURSOR_END = "\u001B_pi:/fc\u0007";

const ESC = "\x1b";
/** Intermediate bytes allowed between the introducer and the final byte. */
const INTERMEDIATE = /[@-Z\\-_]/;
/** Final byte of a 2-byte escape sequence. */
const FINAL = /[0-9A-Za-z~]/;
/** Parameter characters of a CSI sequence (digits, ;, ?, :, <, =, >, !, space). */
const CSI_PARAMS = /[0-9;?:<>!= ]/;
const RED_UNDERLINE = "\x1b[31;4m";
const UL_OFF = "\x1b[24m";
const FG_DEFAULT = "\x1b[39m";

/** Explicit foreground SGR codes. */
const FG_16 = new Set(["30", "31", "32", "33", "34", "35", "36", "37"]);
const FG_BRIGHT = new Set(["90", "91", "92", "93", "94", "95", "96", "97"]);

function isLetter(ch: string): boolean {
	return /[A-Za-z]/.test(ch);
}

/**
 * If line[i] starts an escape sequence, return its total length; else 0.
 * Covers: OSC (ESC ] ... BEL/ST), CSI (ESC [ params final), and 2-byte
 * sequences (ESC x final). Anything else (e.g. the \u001B_pi:* markers,
 * whose ":" is not a valid final byte) is not an escape sequence — the ESC
 * is then treated as an ordinary character by the caller.
 */
function isSeq(line: string, i: number): number {
	if (line[i] !== ESC || i + 1 >= line.length) return 0;
	const second = line[i + 1];
	if (second === "]") {
		// OSC runs to the next BEL or ST (ESC \\).
		let j = i + 2;
		while (j < line.length && line[j] !== "\x07" && !(line[j] === ESC && line[j + 1] === "\\")) j++;
		if (j < line.length) return j - i + (line[j] === ESC ? 2 : 1);
		return 0;
	}
	if (second === "[") {
		let j = i + 2;
		while (j < line.length && CSI_PARAMS.test(line[j])) j++;
		if (j < line.length) return j - i + 1;
		return 0;
	}
	if (INTERMEDIATE.test(second)) {
		let j = i + 2;
		while (j < line.length && INTERMEDIATE.test(line[j])) j++;
		if (j < line.length && FINAL.test(line[j])) return j - i + 1;
		return 0;
	}
	return 0;
}

/**
 * Restore sequence for the foreground group starting at parts[k].
 * Handles 30-37, 38;5;n, 38;2;r;g;b, 39, 90-97.
 */
function restoreFrom(parts: string[], k: number): string {
	const p = parts[k];
	if (p === "39") return FG_DEFAULT;
	if (p === "38") {
		if (parts[k + 1] === "5" && parts[k + 2] !== undefined) return `${ESC}[38;5;${parts[k + 2]}m`;
		if (parts[k + 1] === "2" && parts[k + 4] !== undefined) {
			return `${ESC}[38;2;${parts[k + 2]};${parts[k + 3]};${parts[k + 4]}m`;
		}
		return FG_DEFAULT; // dangling 38: fall back to default fg
	}
	return `${ESC}[${p}m`; // 3x or 9x
}

/**
 * Locate the cursor span on a line and the grapheme under the cursor.
 * Realistic layout: [CURSOR_MARKER] FAKE_CURSOR_START grapheme FAKE_CURSOR_END.
 * Fallback: a bare CURSOR_MARKER (the character after it is the grapheme).
 */
function findCursorSpan(line: string): { start: number; end: number; under: string } | null {
	const fcStart = line.indexOf(FAKE_CURSOR_START);
	if (fcStart >= 0) {
		const fcEnd = line.indexOf(FAKE_CURSOR_END, fcStart + FAKE_CURSOR_START.length);
		if (fcEnd >= 0) {
			const innerStart = fcStart + FAKE_CURSOR_START.length;
			let start = fcStart;
			const cmBefore = fcStart - CURSOR_MARKER.length;
			if (cmBefore >= 0 && line.slice(cmBefore, fcStart) === CURSOR_MARKER) start = cmBefore;
			return {
				start,
				end: fcEnd + FAKE_CURSOR_END.length,
				under: line.slice(innerStart, innerStart + 1),
			};
		}
	}
	const cm = line.indexOf(CURSOR_MARKER);
	if (cm >= 0) {
		const after = cm + CURSOR_MARKER.length;
		return { start: cm, end: after, under: line.slice(after, after + 1) };
	}
	return null;
}

/**
 * Restyle one rendered editor line, wrapping every word for which
 * isMisspelled() returns true in red + underline. See the module
 * documentation for the full contract.
 */
export function styleLine(line: string, isMisspelled: (word: string) => boolean): string {
	// Fast path: nothing to check.
	let hasLetters = false;
	for (let i = 0; i < line.length; i++) {
		if (isLetter(line[i])) {
			hasLetters = true;
			break;
		}
	}
	if (!hasLetters) return line;

	const span = findCursorSpan(line);
	const splitsWord = span !== null && isLetter(span.under);
	const out: string[] = [];
	let i = 0;
	let fgRestore: string | null = null;
	const n = line.length;

	while (i < n) {
		const seqLen = isSeq(line, i);
		if (seqLen > 0) {
			const seq = line.slice(i, i + seqLen);
			out.push(seq);
			if (seq[1] === "[" && seq.endsWith("m")) {
				// SGR: track the foreground in effect.
				const params = seq.slice(2, -1);
				if (params === "" || params.split(";").includes("0")) {
					fgRestore = null; // full reset
				} else {
					const parts = params.split(";");
					for (let k = parts.length - 1; k >= 0; k--) {
						const p = parts[k];
						if (p === "39" || p === "38" || FG_16.has(p) || FG_BRIGHT.has(p)) {
							fgRestore = restoreFrom(parts, k);
							break;
						}
					}
					// No foreground part (pure attribute/bg): keep prior state.
				}
			}
			i += seqLen;
			continue;
		}

		const ch = line[i];
		if (!isLetter(ch)) {
			out.push(ch);
			i++;
			continue;
		}

		// Word token: maximal run of letters.
		let j = i;
		while (j < n && isLetter(line[j])) j++;
		const word = line.slice(i, j);

		// Never restyle a fragment that touches a word-splitting cursor span.
		if (splitsWord && (j === span.start || i === span.end || (i < span.end && j > span.start))) {
			out.push(word);
			i = j;
			continue;
		}

		if (word.length >= 3 && isMisspelled(word)) {
			out.push(`${RED_UNDERLINE}${word}${fgRestore ?? FG_DEFAULT}${UL_OFF}`);
		} else {
			out.push(word);
		}
		i = j;
	}

	return out.join("");
}
