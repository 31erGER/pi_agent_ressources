/**
 * Unit tests for the pure logic of the message-markers extension.
 *
 * Run with plain node (v26+ executes .ts natively, erasable-only TS):
 *   node /home/julian/.pi/agent/projects/message-markers/tests/message-markers.test.ts
 */

import { strict as assert } from "node:assert";
import { Container } from "@earendil-works/pi-tui";
import {
	collectUserMessageOffsets,
	computeRail,
	isUserMessageLike,
	markerIndexForClick,
	pickActiveIndex,
	railCapacity,
	railMarkerColumn,
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

test("railCapacity: one dot per row (≈15px spacing) — viewport minus 2, min 3", () => {
	assert.equal(railCapacity(40), 38);
	assert.equal(railCapacity(100), 98);
	assert.equal(railCapacity(14), 12);
	assert.equal(railCapacity(6), 4);
	assert.equal(railCapacity(4), 3); // 4-2=2 clamped up to 3
	assert.equal(railCapacity(1), 3);
	assert.equal(railCapacity(0), 3);
});

// ---------------------------------------------------------------------------
// railMarkerColumn
// ---------------------------------------------------------------------------

test("railMarkerColumn: 3 columns (≈20px) left of the scrollbar column", () => {
	assert.equal(railMarkerColumn(100), 96); // scrollbar at 99, gap cols 97-99
	assert.equal(railMarkerColumn(80), 76);
	assert.equal(railMarkerColumn(8), 4);
	assert.equal(railMarkerColumn(4), 0); // never negative
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

test("collectUserMessageOffsets: finds user messages at any nesting depth", () => {
	const doc = {
		children: [
			fakeLines(2), // rows 0..2
			{
				children: [
					{
						children: [
							{
								children: [userMsg(3)], // user at 3 levels below doc, row 2
							},
							],
						},
					],
				},
			],
	};
	assert.deepEqual(collectUserMessageOffsets(doc, 80), [2]);
});

test("collectUserMessageOffsets: real pi Containers are descended (production shape)", () => {
	// In pi 1.5.0 the transcript document is a Container that composites its
	// children via Container.prototype.render — the walker must descend into
	// it, not treat it as a rendered leaf.
	const doc = new Container();
	const filler = fakeLines(2);
	const msg = userMsg(3);
	const chat = new Container();
	chat.addChild(filler);
	chat.addChild(msg);
	const header = new Container();
	doc.addChild(header);
	doc.addChild(chat);
	assert.deepEqual(collectUserMessageOffsets(doc, 80), [2]);
});

test("collectUserMessageOffsets: does not descend into rendered components", () => {
	// A component with its own render() is measured as a leaf; its children
	// (even user-shaped ones) are part of its rendering, not separate rows.
	const renderedParent = fakeLines(4, { children: [userMsg(2)] });
	const doc = { children: [renderedParent, userMsg(1)] };
	assert.deepEqual(collectUserMessageOffsets(doc, 80), [4]);
});

// ---------------------------------------------------------------------------
// computeRail (shared geometry for rendering AND click mapping)
// ---------------------------------------------------------------------------

test("computeRail: null when there are no user messages", () => {
	assert.equal(computeRail(100, [], 0, 40, 200), null);
});

test("computeRail: marks, active flag, vertical centering and column", () => {
	const rail = computeRail(100, [10, 50, 90], 45, 40, 200);
	assert.ok(rail);
	assert.equal(rail.col, 96);
	assert.deepEqual(rail.marks.map((m) => m.index), [0, 1, 2]);
	assert.deepEqual(rail.marks.map((m) => m.active), [false, true, false]);
	// 3 marks in a 40-row viewport → top = floor((40-3)/2) = 18
	assert.equal(rail.top, 18);
});

test("computeRail: leading ellipsis when windowed", () => {
	const rows = Array.from({ length: 50 }, (_, i) => i);
	const rail = computeRail(100, rows, 0, 40, 50);
	assert.ok(rail);
	// capacity 38, active 39 → window [12..49] → leading ellipsis + 38 dots
	assert.equal(rail.marks.length, 39);
	assert.equal(rail.marks[0].index, null);
	assert.equal(rail.marks[1].index, 12);
	assert.equal(rail.marks[38].index, 49);
	assert.equal(rail.marks[28].active, true); // index 39 is active
	// 39 marks in a 40-row viewport → top = floor((40-39)/2) = 0
	assert.equal(rail.top, 0);
});

test("computeRail: centers within the visible part when the document is shorter than the viewport", () => {
	const rail = computeRail(100, [2], 0, 40, 5);
	assert.ok(rail);
	assert.equal(rail.marks.length, 1);
	assert.equal(rail.top, 2); // floor((5-1)/2)

	const rail2 = computeRail(100, [2, 8], 3, 40, 10);
	assert.ok(rail2);
	assert.equal(rail2.top, 2); // visible = min(40, 10-3)=7 → floor((7-2)/2)=2
	assert.equal(rail2.marks[1].active, true);
});

// ---------------------------------------------------------------------------
// markerIndexForClick
// ---------------------------------------------------------------------------

test("markerIndexForClick: maps a document row to the user-message index", () => {
	const rail = computeRail(100, [10, 50, 90], 45, 40, 200)!;
	// mark i sits at document row scrollTop + top + i = 45 + 18 + i
	assert.equal(markerIndexForClick(63, rail, 45), 0);
	assert.equal(markerIndexForClick(64, rail, 45), 1);
	assert.equal(markerIndexForClick(65, rail, 45), 2);
	// outside the rail block → null
	assert.equal(markerIndexForClick(62, rail, 45), null);
	assert.equal(markerIndexForClick(66, rail, 45), null);
});

test("markerIndexForClick: ellipsis rows map to null", () => {
	const rows = Array.from({ length: 50 }, (_, i) => i);
	const rail = computeRail(100, rows, 0, 40, 50)!;
	assert.equal(markerIndexForClick(0, rail, 0), null); // leading ellipsis row
	assert.equal(markerIndexForClick(1, rail, 0), 12); // first real dot
});

// ---------------------------------------------------------------------------

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
