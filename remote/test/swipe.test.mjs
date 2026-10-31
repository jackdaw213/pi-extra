// Seam: hub/web/app/swipe.mjs — pure swipe gesture state machine.
// Node-import-safe: no DOM at module level. Event data in, reveal state out.
//
// Semantics under test (numbers are the contract with dashboard.mjs):
//   - tap slop 10 px: movement within it is a tap, not a swipe
//   - axis lock: vertical-dominant drags never open (scrolling stays native)
//   - horizontal drag: card follows the finger, clamped to [-1.7 * reveal, 0]
//   - release: full swipe (|travel| > 1.6 * reveal) OR leftward flick
//     velocity > 0.6 px/ms fires delete; else snap open (< -reveal/2) or closed
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSwipeMachine,
  TAP_SLOP_PX,
  REVEAL_WIDTH_PX,
  FULL_SWIPE_RATIO,
  FLICK_VELOCITY_PX_PER_MS,
  REVEAL_MAX_PX,
} from "../hub/web/app/swipe.mjs";

test("module imports in Node without DOM", () => {
  assert.equal(typeof createSwipeMachine, "function");
  assert.equal(typeof TAP_SLOP_PX, "number");
  assert.equal(typeof REVEAL_WIDTH_PX, "number");
});

test("horizontal right-to-left drag past half reveal snaps open", () => {
  const m = createSwipeMachine();
  assert.equal(m.state.reveal, "closed");
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  const mid = m.update({ phase: "move", x: 150, y: 101, t: 40 });
  // Mid-drag the card follows the finger as a negative translation in px.
  assert.equal(mid.reveal, "opening");
  assert.ok(mid.px < 0 && mid.px >= -REVEAL_MAX_PX, `px in range, got ${mid.px}`);
  const end = m.update({ phase: "end", x: 150, y: 101, t: 60 });
  assert.equal(end.reveal, "open");
  assert.equal(end.px, -REVEAL_WIDTH_PX);
  assert.equal(end.action, null);
});

test("short horizontal drag snaps closed again", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  m.update({ phase: "move", x: 190, y: 100, t: 30 }); // past slop, horizontal
  const end = m.update({ phase: "end", x: 190, y: 100, t: 50 });
  assert.equal(end.reveal, "closed");
  assert.equal(end.px, 0);
  assert.equal(end.action, null);
});

test("vertical-dominant drag never opens and reports axis y", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  const mid = m.update({ phase: "move", x: 195, y: 160, t: 40 }); // dy >> dx
  assert.equal(mid.axis, "y");
  assert.notEqual(mid.reveal, "opening");
  assert.equal(mid.px, 0);
  const end = m.update({ phase: "end", x: 195, y: 160, t: 60 });
  assert.equal(end.reveal, "closed");
  assert.equal(end.action, null);
});

test("movement within the slop is a tap and never opens or deletes", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  const end = m.update({
    phase: "end",
    x: 200 + Math.floor(TAP_SLOP_PX / 2),
    y: 100 + 2,
    t: 30,
  });
  assert.equal(end.tap, true);
  assert.equal(end.reveal, "closed");
  assert.equal(end.action, null);
});

test("movement beyond the slop is not a tap", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  m.update({ phase: "move", x: 120, y: 100, t: 40 });
  const end = m.update({ phase: "end", x: 120, y: 100, t: 60 });
  assert.equal(end.tap, false);
  assert.equal(end.reveal, "open");
});

test("drag beyond the full-swipe threshold fires delete", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  // Slow drag (no flick), travel > 1.6 * reveal.
  const travel = Math.ceil(REVEAL_WIDTH_PX * FULL_SWIPE_RATIO) + 10;
  m.update({ phase: "move", x: 200 - 40, y: 100, t: 300 });
  const end = m.update({ phase: "end", x: 200 - travel, y: 100, t: 900 });
  assert.equal(end.action, "delete");
  assert.equal(end.reveal, "closed");
  assert.equal(end.tap, false);
});

test("leftward flick faster than the velocity threshold fires delete", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  // Small travel (would snap closed), but the last move is fast leftward.
  m.update({ phase: "move", x: 185, y: 100, t: 200 }); // slow, locks axis x
  const end = m.update({ phase: "end", x: 175, y: 100, t: 215 }); // 10px/15ms = 0.67 px/ms
  assert.ok(
    FLICK_VELOCITY_PX_PER_MS < 10 / 15,
    "test must exceed the threshold, otherwise it proves nothing"
  );
  assert.equal(end.action, "delete");
  assert.equal(end.reveal, "closed");
});

test("slow short drag does NOT fire delete (velocity below threshold)", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  m.update({ phase: "move", x: 180, y: 100, t: 500 }); // 20px over 500ms = 0.04 px/ms
  const end = m.update({ phase: "end", x: 178, y: 100, t: 600 });
  assert.equal(end.action, null);
  assert.equal(end.reveal, "closed");
});

test("rightward flick never deletes", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  m.update({ phase: "move", x: 190, y: 100, t: 200 });
  const end = m.update({ phase: "end", x: 210, y: 100, t: 210 }); // fast rightward
  assert.equal(end.action, null);
  assert.equal(end.reveal, "closed");
});

test("mid-drag translation is clamped to [-1.7 * reveal, 0]", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 500, y: 100, t: 0 });
  const far = m.update({ phase: "move", x: 0, y: 100, t: 50 }); // dx -500
  assert.equal(far.px, -REVEAL_MAX_PX);
  const right = m.update({ phase: "move", x: 800, y: 100, t: 80 }); // dx +300
  assert.equal(right.px, 0);
});

test("starting from an open row: small leftward drag closes or deletes per thresholds", () => {
  const m = createSwipeMachine();
  // Row is open: the card rests at -REVEAL_WIDTH_PX; gesture carries offset.
  m.update({ phase: "start", x: 200, y: 100, t: 0, offset: -REVEAL_WIDTH_PX });
  m.update({ phase: "move", x: 185, y: 100, t: 100 }); // 15px further left
  const end = m.update({ phase: "end", x: 185, y: 100, t: 400 });
  // Effective translation -87 is past full swipe of 115.2? No: 72+15=87 < 115.2,
  // slow flick -> snaps back open.
  assert.equal(end.reveal, "open");

  const m2 = createSwipeMachine();
  m2.update({ phase: "start", x: 200, y: 100, t: 0, offset: -REVEAL_WIDTH_PX });
  m2.update({ phase: "move", x: 60, y: 100, t: 200 }); // 140px further left
  const end2 = m2.update({ phase: "end", x: 60, y: 100, t: 500 });
  assert.equal(end2.action, "delete");
});

test("starting from an open row: rightward drag past half reveal closes it", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0, offset: -REVEAL_WIDTH_PX });
  m.update({ phase: "move", x: 250, y: 100, t: 100 }); // +50px rightward
  const end = m.update({ phase: "end", x: 250, y: 100, t: 300 });
  assert.equal(end.reveal, "closed");
  assert.equal(end.px, 0);
});

test("cancel resets to closed with no action", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  m.update({ phase: "move", x: 140, y: 100, t: 40 });
  const cancelled = m.update({ phase: "cancel" });
  assert.equal(cancelled.reveal, "closed");
  assert.equal(cancelled.tap, false);
  assert.equal(cancelled.action, null);
});

test("machine is reusable after an open state (start resets the gesture)", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  m.update({ phase: "move", x: 120, y: 100, t: 40 });
  m.update({ phase: "end", x: 120, y: 100, t: 60 });
  assert.equal(m.state.reveal, "open");
  m.update({ phase: "start", x: 300, y: 100, t: 100 });
  const end = m.update({ phase: "end", x: 300, y: 100, t: 120 });
  assert.equal(end.tap, true);
  assert.equal(end.action, null);
});

test("machine is reusable after a delete action (start resets the gesture)", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100, t: 0 });
  m.update({ phase: "move", x: 40, y: 100, t: 100 });
  m.update({ phase: "end", x: 40, y: 100, t: 200 });
  assert.equal(m.state.action, "delete");
  m.update({ phase: "start", x: 300, y: 100, t: 300 });
  const end = m.update({ phase: "end", x: 300, y: 100, t: 320 });
  assert.equal(end.tap, true);
  assert.equal(end.action, null);
});

test("missing timestamps degrade gracefully (no flick detection, no crash)", () => {
  const m = createSwipeMachine();
  m.update({ phase: "start", x: 200, y: 100 });
  m.update({ phase: "move", x: 150, y: 100 }); // no t
  const end = m.update({ phase: "end", x: 150, y: 100 }); // no t
  assert.equal(end.reveal, "open");
  assert.equal(end.action, null);
});
