// Ask-user question mapping (shared/question.mjs) — tool-input parsing and
// argument decoding feeding the A_QUESTION bridge (ADR 0008).
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractQuestion, decodeAskUserArguments } from "../shared/question.mjs";

const T = (name, fn) => test(name, fn);

// ---- canonical shapes -----------------------------------------------------

T("flat form: question + plain-string options", () => {
  const q = extractQuestion("ask_user_question", {
    question: "Which library?",
    options: ["left-pad", "lodash"],
  });
  assert.deepEqual(q, { question: "Which library?", options: ["left-pad", "lodash"], multiSelect: false });
});

T("flat form: options as {label} objects", () => {
  const q = extractQuestion("ask_user_question", {
    question: "Which library?",
    options: [
      { label: "left-pad", description: "tiny" },
      { label: "lodash" },
    ],
  });
  assert.deepEqual(q, { question: "Which library?", options: ["left-pad", "lodash"], multiSelect: false });
});

T("questions-array form: first question wins", () => {
  const q = extractQuestion("ask_user_question", {
    questions: [
      { question: "Auth method?", options: [{ label: "token" }, { label: "password" }] },
      { question: "Second?", options: ["a", "b"] },
    ],
  });
  assert.deepEqual(q, { question: "Auth method?", options: ["token", "password"], multiSelect: false });
});

T("questions-array form skips entries without question text", () => {
  const q = extractQuestion("ask_user_question", {
    questions: [
      { header: "no text", options: ["a", "b"] },
      { question: "Real?", options: ["a", "b"] },
    ],
  });
  assert.deepEqual(q, { question: "Real?", options: ["a", "b"], multiSelect: false });
});

T("multiSelect flag passes through (entry level)", () => {
  const q = extractQuestion("learn_ask_user_question", {
    questions: [{ question: "Pick many?", options: ["a", "b"], multiSelect: true }],
  });
  assert.equal(q.multiSelect, true);
});

T("multiSelect flag passes through (flat form)", () => {
  const q = extractQuestion("ask_user_question", { question: "Q?", options: ["a"], multiSelect: true });
  assert.equal(q.multiSelect, true);
});

T("multiSelect falls back to top level when entry lacks it", () => {
  const q = extractQuestion("ask_user_question", {
    multiSelect: true,
    questions: [{ question: "Q?", options: ["a", "b"] }],
  });
  assert.equal(q.multiSelect, true);
});

T("mixed option entries: strings kept, junk dropped", () => {
  const q = extractQuestion("ask_user_question", {
    question: "Q?",
    options: ["a", 42, { label: "b" }, { nope: 1 }, null],
  });
  assert.deepEqual(q, { question: "Q?", options: ["a", "b"], multiSelect: false });
});

T("non-string labels are coerced best-effort from objects", () => {
  // {label: 123} — the number has a String() form; best-effort keeps "123".
  const q = extractQuestion("ask_user_question", { question: "Q?", options: [{ label: 123 }] });
  assert.deepEqual(q, { question: "Q?", options: ["123"], multiSelect: false });
});

T("question with zero usable options still renders (custom answer path)", () => {
  const q = extractQuestion("ask_user_question", { question: "Free text?", options: [] });
  assert.deepEqual(q, { question: "Free text?", options: [], multiSelect: false });
});

T("options missing entirely -> empty options", () => {
  const q = extractQuestion("ask_user_question", { question: "Q?" });
  assert.deepEqual(q, { question: "Q?", options: [], multiSelect: false });
});

// ---- tool-name gate -------------------------------------------------------

T("non ask-user tool names return null", () => {
  assert.equal(extractQuestion("bash", { question: "Q?", options: ["a"] }), null);
  assert.equal(extractQuestion("read", { question: "Q?", options: ["a"] }), null);
  assert.equal(extractQuestion("ask_user_questions", { question: "Q?", options: ["a"] }), null);
});

T("namespaced ask-user variants still match", () => {
  assert.ok(extractQuestion("learn_ask_user_question", { question: "Q?", options: ["a"] }));
});

// ---- garbage --------------------------------------------------------------

T("garbage inputs return null", () => {
  assert.equal(extractQuestion("ask_user_question", null), null);
  assert.equal(extractQuestion("ask_user_question", undefined), null);
  assert.equal(extractQuestion("ask_user_question", 42), null);
  assert.equal(extractQuestion("ask_user_question", "str"), null);
  assert.equal(extractQuestion("ask_user_question", {}), null);
  assert.equal(extractQuestion("ask_user_question", { options: ["a", "b"] }), null); // no question text
  assert.equal(extractQuestion("ask_user_question", { questions: [] }), null);
  assert.equal(extractQuestion("ask_user_question", { questions: "not-an-array" }), null);
  assert.equal(extractQuestion("ask_user_question", { question: 42, options: ["a"] }), null);
  assert.equal(extractQuestion("ask_user_question", { question: "", options: ["a"] }), null);
});

T("multiSelect non-boolean is ignored (defaults false)", () => {
  const q = extractQuestion("ask_user_question", {
    question: "Q?",
    options: ["a"],
    multiSelect: "yes",
  });
  assert.equal(q.multiSelect, false);
});

// ---- replacement-tool argument decoding (prepareArguments) ----------------

T("decode: stringified questions array is decoded in place", () => {
  const args = decodeAskUserArguments({
    questions: JSON.stringify([{ question: "Q?", options: [{ label: "a" }, { label: "b" }] }]),
  });
  assert.ok(extractQuestion("ask_user_question", args));
  assert.deepEqual(args.questions[0].options, [{ label: "a" }, { label: "b" }]);
});

T("decode: stringified options inside questions are decoded", () => {
  const args = decodeAskUserArguments({
    questions: [{ question: "Q?", options: JSON.stringify(["a", "b"]) }],
  });
  assert.deepEqual(extractQuestion("ask_user_question", args).options, ["a", "b"]);
});

T("decode: flat stringified options array is decoded", () => {
  const args = decodeAskUserArguments({ question: "Q?", options: JSON.stringify(["a", "b"]) });
  assert.deepEqual(extractQuestion("learn_ask_user_question", args).options, ["a", "b"]);
});

T("decode: plain inputs pass through unchanged", () => {
  const args = { questions: [{ question: "Q?", options: ["a", "b"] }] };
  assert.deepEqual(decodeAskUserArguments(args), args);
});

T("decode: unparseable JSON strings stay strings (validation rejects, not us)", () => {
  const args = decodeAskUserArguments({ questions: "{nope" });
  assert.equal(args.questions, "{nope");
});

T("decode: non-object args pass through", () => {
  assert.equal(decodeAskUserArguments(null), null);
  assert.equal(decodeAskUserArguments(undefined), undefined);
  assert.equal(decodeAskUserArguments(42), 42);
  assert.deepEqual(decodeAskUserArguments([1]), [1]);
});

T("decode: stringified JSON scalars stay raw strings (only arrays/objects decode)", () => {
  const args = decodeAskUserArguments({ questions: JSON.stringify("just a string") });
  assert.equal(args.questions, '"just a string"');
});

