/**
 * Unit tests for the pure logic of the message-markers extension.
 *
 * Run with plain node (v26+ executes .ts natively, erasable-only TS):
 *   node /home/julian/.pi/agent/projects/message-markers/tests/message-markers.test.ts
 */

import { strict as assert } from "node:assert";
import {
	collectUserMessageOffsets,
	isUserMessageLike,
	pickActiveIndex,
	railCapacity,
	windowIndices,
} from "../../../extensions/message-markers.ts";

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void): void {
	try {
		fn();
		passes++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		failures++;
		console.error(`  FAIL ${name}`);
		console.error(String(err).split("\n").slice(0, 4).join("\n"));
	}
}

// ---------------------------------------------------------------------------
// isUserMessageLike
// ---------------------------------------------------------------------------

test("isUserMessageLike: true for user-message-shaped component", () => {
	assert.equal(isUserMessageLike({ text: "hi", markdownTransformers: [] }), true);
	assert.equal(
		isUserMessageLike({ text: "hi", markdownTransformers: [], messageId: "e1" }),
		true,
	);
});

test("isUserMessageLike: false for assistant-message-shaped component (has message field)", () => {
	assert.equal(
		isUserMessageLike({ text: "x", markdownTransformers: [], message: { role: "assistant" } }),
		false,
	);
	assert.equal(
		isUserMessageLike({ markdownTransformers: [], message: undefined, lastMessage: null }),
		false,
	);
});

test("isUserMessageLike: false for plain containers and junk", () => {
	assert.equal(isUserMessageLike(null), false);
	assert.equal(isUserMessageLike(undefined), false);
	assert.equal(isUserMessageLike(42), false);
	assert.equal(isUserMessageLike("text"), false);
	assert.equal(isUserMessageLike({ children: [] }), false);
	assert.equal(isUserMessageLike({ text: 5, markdownTransformers: [] }), false);
	assert.equal(isUserMessageLike({ text: "hi", markdownTransformers: null }), false);
	assert.equal(isUserMessageLike({ text: "hi" }), false);
});

// ---------------------------------------------------------------------------
// pickActiveIndex
// ---------------------------------------------------------------------------

test("pickActiveIndex: -1 when there are no user messages", () => {
	assert.equal(pickActiveIndex([], 0, 40), -1);
});

test("pickActiveIndex: viewport above the first user message highlights the first one", () => {
	assert.equal(pickActiveIndex([100], 0, 40), 0);
	assert.equal(pickActiveIndex([10, 50, 90], 0, 8), 0);
});

test("pickActiveIndex: last user message starting above the viewport bottom wins", () => {
	// rows [10, 50, 90]; viewport [45..85) → msg at 50 starts inside, msg at 90 below
	assert.equal(pickActiveIndex([10, 50, 90], 45, 40), 1);
	// viewport [5..45) → only msg at 10 qualifies
	assert.equal(pickActiveIndex([10, 50, 90], 5, 40), 0);
	// viewport [88..128) → msg at 90 qualifies (last visible)
	assert.equal(pickActiveIndex([10, 50, 90], 88, 40), 2);
});

test("pickActiveIndex: scrolled past the end keeps the last message active", () => {
	assert.equal(pickActiveIndex([10, 50, 90], 500, 40), 2);
});

test("pickActiveIndex: a message starting exactly at the viewport bottom is not yet active", () => {
	// row 40, viewport [0..40): 40 < 40 is false → falls back to row 10
	assert.equal(pickActiveIndex([10, 40], 0, 40), 0);
});

// ---------------------------------------------------------------------------
// railCapacity
// ---------------------------------------------------------------------------

test("railCapacity: half the viewport height, clamped to [3, 15]", () => {
	assert.equal(railCapacity(40), 15); // floor(20) clamped down to 15
	assert.equal(railCapacity(100), 15);
	assert.equal(railCapacity(30), 15); // floor(15)
	assert.equal(railCapacity(28), 14); // floor(14)
	assert.equal(railCapacity(10), 5);
	assert.equal(railCapacity(6), 3);
	assert.equal(railCapacity(4), 3); // floor(2) clamped up to 3
	assert.equal(railCapacity(1), 3);
});

// ---------------------------------------------------------------------------
// windowIndices
// ---------------------------------------------------------------------------

test("windowIndices: returns all indices when they fit", () => {
	assert.deepEqual(windowIndices(5, 2, 15), [0, 1, 2, 3, 4]);
	assert.deepEqual(windowIndices(1, 0, 3), [0]);
	assert.deepEqual(windowIndices(0, -1, 3), []);
});

test("windowIndices: clamps the window at both ends", () => {
	assert.deepEqual(windowIndices(10, 0, 3), [0, 1, 2]);
	assert.deepEqual(windowIndices(10, 9, 3), [7, 8, 9]);
});

test("windowIndices: centers the window on the active index", () => {
	assert.deepEqual(windowIndices(10, 4, 3), [3, 4, 5]);
	assert.deepEqual(windowIndices(20, 10, 5), [8, 9, 10, 11, 12]);
	assert.deepEqual(windowIndices(20, 0, 5), [0, 1, 2, 3, 4]);
	assert.deepEqual(windowIndices(20, 19, 5), [15, 16, 17, 18, 19]);
});

test("windowIndices: always contains the active index", () => {
	for (let count = 1; count <= 60; count += 7) {
		const capacity = railCapacity(24);
		for (let active = 0; active < count; active++) {
			const window = windowIndices(count, active, capacity);
			assert.ok(
				window.includes(active),
				`active ${active} missing from window ${window.join(",")} (count=${count})`,
			);
			assert.equal(window.length, Math.min(count, capacity));
		}
	}
});

// ---------------------------------------------------------------------------
// collectUserMessageOffsets
// ---------------------------------------------------------------------------

/** Fake rendered component: returns a fixed number of lines. */
function fakeLines(lines: number, extra: Record<string, unknown> = {}): object {
	return { render: () => Array.from({ length: lines }, () => ""), ...extra };
}

function userMsg(lines: number): object {
	return fakeLines(lines, { text: "user text", markdownTransformers: [] });
}

function assistantMsg(lines: number): object {
	return fakeLines(lines, { markdownTransformers: [], message: { role: "assistant" } });
}

test("collectUserMessageOffsets: walks document → chat container and sums heights", () => {
	const document = {
		children: [
			{ children: [fakeLines(3)] }, // header container
			{ children: [] }, // loaded resources
			{
				children: [
					assistantMsg(5), // rows 3..8
					userMsg(2), // user #1 starts at row 8
					fakeLines(1), // spacer
					userMsg(4), // user #2 starts at row 11
					assistantMsg(6),
				],
			},
		],
	};
	assert.deepEqual(collectUserMessageOffsets(document, 80), [8, 11]);
});

test("collectUserMessageOffsets: width is passed through to child render", () => {
	const seen: number[] = [];
	const doc = {
		children: [
			{ children: [userMsg(2)], },
		],
	};
	const original = (doc.children[0].children[0] as { render: (w: number) => string[] }).render;
	(doc.children[0].children[0] as { render: (w: number) => string[] }).render = (w: number) => {
		seen.push(w);
		return original(w);
	};
	assert.deepEqual(collectUserMessageOffsets(doc, 123), [0]);
	assert.deepEqual(seen, [123]);
});

test("collectUserMessageOffsets: handles user messages placed directly in the document", () => {
	const doc = { children: [fakeLines(2), userMsg(3)] };
	assert.deepEqual(collectUserMessageOffsets(doc, 80), [2]);
});

test("collectUserMessageOffsets: non-renderable children count as 0 lines", () => {
	const doc = {
		children: [
			{ children: [null, userMsg(2)] },
		],
	};
	assert.deepEqual(collectUserMessageOffsets(doc, 80), [0]);
});

test("collectUserMessageOffsets: no user messages → empty array", () => {
	const doc = {
		children: [
			{ children: [assistantMsg(5), fakeLines(2)] },
		],
	};
	assert.deepEqual(collectUserMessageOffsets(doc, 80), []);
});

test("collectUserMessageOffsets: invalid input → empty array", () => {
	assert.deepEqual(collectUserMessageOffsets(null, 80), []);
	assert.deepEqual(collectUserMessageOffsets({ children: "nope" }, 80), []);
	assert.deepEqual(collectUserMessageOffsets({}, 80), []);
});

// ---------------------------------------------------------------------------

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
