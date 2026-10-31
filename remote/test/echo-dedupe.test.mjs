// Seam: util.isInputEcho — the phone's own sent text must not render twice.
// The transcript's user message carries the sent text PLUS display lines for
// image attachments, so the echo check is a prefix match, not equality.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isInputEcho } from "../hub/web/app/util.mjs";

test("exact text is an echo", () => {
  assert.ok(isInputEcho("hello", "hello"));
});

test("message text that continues the sent text is an echo (image display lines)", () => {
  const sent = "look at this\n- attached file (saved): /tmp/a.png";
  const echoed = sent + "\n[Image: original 1170x2532, displayed at 924x2000]";
  assert.ok(isInputEcho(sent, echoed));
});

test("whitespace-only difference is an echo (dictation adds trailing spaces)", () => {
  assert.ok(isInputEcho("hello world ", "hello world"));
  assert.ok(isInputEcho(" hello", "hello"));
});

// The typed text's own trailing spaces sit before the "\n" separator of the
// appended display line, and a leading space is stripped by userTextFrom().
test("image display lines still an echo with trailing/leading whitespace on the sent text", () => {
  assert.ok(isInputEcho("hello ", "hello \n- attached file (saved): /tmp/a.png"));
  assert.ok(isInputEcho("hello ", "hello\n- attached file (saved): /tmp/a.png"));
  assert.ok(isInputEcho(" hello", "hello\n- attached file (saved): /tmp/a.png"));
});

test("a different message is not an echo", () => {
  assert.ok(!isInputEcho("hello", "completely different"));
  assert.ok(!isInputEcho("hello", "hello world, but a real new message"));
});

test("a message that merely extends the sent text without whitespace is not an echo", () => {
  assert.ok(!isInputEcho("hello world", "hello worldX"));
});

test("empty or missing pending input is never an echo", () => {
  assert.ok(!isInputEcho(null, "hello"));
  assert.ok(!isInputEcho("", "hello"));
  assert.ok(!isInputEcho("   ", "hello"));
});

// Multi-question ask calls are terminal-only: rpiv's answer channel is
// all-or-nothing per call, so the phone answers single-question calls and a
// multi-question call gets a guidance block instead of a stranding card.
import { isMultiQuestionCall } from "../shared/question.mjs";

test("multi-question detection on decoded input", () => {
  assert.ok(!isMultiQuestionCall({ questions: [{ question: "a", options: ["x", "y"] }] }));
  assert.ok(isMultiQuestionCall({ questions: [{ question: "a", options: ["x", "y"] }, { question: "b", options: ["x", "y"] }] }));
  assert.ok(!isMultiQuestionCall({ question: "a", options: ["x", "y"] }));
  assert.ok(!isMultiQuestionCall(null));
});

// Bubble display: attachment plumbing lines are stripped, typed text stays.
import { userDisplayText } from "../hub/web/app/util.mjs";

test("display text drops attachment plumbing lines", () => {
  assert.equal(
    userDisplayText("look at this\n- attached file (saved): /tmp/a.png\n\n[Image: original 1170x2532, displayed at 924x2000. Multiply coordinates by 1.27 to map to original image.]"),
    "look at this"
  );
  assert.equal(userDisplayText("- attached file (saved): /tmp/a.png"), "");
  assert.equal(userDisplayText("a\n- attached file (saved): /x\n- attached file (saved): /y"), "a");
});

test("display text keeps ordinary text untouched", () => {
  assert.equal(userDisplayText("hello world "), "hello world");
  assert.equal(userDisplayText("note: see - attached file (saved): inline"), "note: see - attached file (saved): inline");
  assert.equal(userDisplayText(""), "");
});
