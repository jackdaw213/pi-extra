// Ask-user bridge (ADR 0008) — pure mapping seams. pi-remote registers no ask
// tool; the main rpiv extension (@juicesharp/rpiv-ask-user-question) owns the
// tool and the terminal dialog. pi-remote maps forwarded ask tool calls to the
// A_QUESTION frame, delivers phone answers through rpiv's external answer
// channel, and settles phone cards from forwarded ask tool results.
//
// Event names and payload shapes per the rpiv source on this machine:
//   events.ts            — ASK_USER_ANSWER_EVENT / ASK_USER_ANSWER_RESULT_EVENT
//   tool/external-answer.ts — accepted answer payload (QuestionnaireResult encoding)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	ASK_USER_ANSWER_EVENT,
	ASK_USER_ANSWER_RESULT_EVENT,
	questionFromToolInput,
	answerChannelPayload,
	blockedReason,
	phoneSettleFromToolResult,
} from "../shared/question.mjs";

const T = (name, fn) => test(name, fn);

// ---- rpiv event name constants (stability policy: channels never rename) ----

T("answer-channel event names match the rpiv contract", () => {
	assert.equal(ASK_USER_ANSWER_EVENT, "rpiv:ask-user:answer");
	assert.equal(ASK_USER_ANSWER_RESULT_EVENT, "rpiv:ask-user:answer-result");
});

// ---- tool input -> A_QUESTION payload mapping (bridge-in) -------------------
// The forwarded tool_execution_start carries RAW model args; rpiv's own
// prepareQuestionArguments decodes only for the tool, so the mapping decodes
// defensively itself (double-encoded arrays as JSON strings).

T("map: single canonical question", () => {
	const q = questionFromToolInput("ask_user_question", {
		questions: [{ question: "Deploy now?", options: [{ label: "yes" }, { label: "no" }] }],
	});
	assert.deepEqual(q, { question: "Deploy now?", options: ["yes", "no"], multiSelect: false });
});

T("map: several questions -> null (terminal-only; rpiv channel is all-or-nothing)", () => {
	const q = questionFromToolInput("ask_user_question", {
		questions: [
			{ question: "First?", options: ["a", "b"], multiSelect: true },
			{ question: "Second?", options: ["c", "d"] },
		],
	});
	assert.equal(q, null);
});

T("map: double-encoded questions array (rpiv prepareQuestionArguments shape)", () => {
	const q = questionFromToolInput("ask_user_question", {
		questions: JSON.stringify([{ question: "Q?", options: JSON.stringify(["a", "b"]) }]),
	});
	assert.deepEqual(q, { question: "Q?", options: ["a", "b"], multiSelect: false });
});

T("map: double-encoded flat options (learn-style input)", () => {
	const q = questionFromToolInput("learn_ask_user_question", {
		question: "Q?",
		options: JSON.stringify([{ label: "a" }, { label: "b" }]),
	});
	assert.deepEqual(q, { question: "Q?", options: ["a", "b"], multiSelect: false });
});

T("map: garbage input -> null (no card)", () => {
	assert.equal(questionFromToolInput("ask_user_question", null), null);
	assert.equal(questionFromToolInput("ask_user_question", {}), null);
	assert.equal(questionFromToolInput("ask_user_question", { questions: "{nope" }), null);
	assert.equal(questionFromToolInput("ask_user_question", { questions: [] }), null);
	assert.equal(questionFromToolInput("bash", { question: "Q?", options: ["a"] }), null);
});

// ---- phone answer -> answer-channel event payload (bridge-out) -------------
// AskUserAnswerEventPayload body: { toolCallId, requestId?, answers?, cancel? }.
// One entry per question; optionIndexes are 0-based into the prompt's options;
// multi-select takes indexes and/or text; cancel takes no answers
// (tool/external-answer.ts validation is strict and all-or-nothing).

T("payload: tapped option value -> optionIndexes", () => {
	assert.deepEqual(answerChannelPayload({ value: "gamma", cancelled: false }, ["alpha", "beta", "gamma"], false), {
		answers: [{ questionIndex: 0, optionIndexes: [2] }],
	});
});

T("payload: custom text -> text entry", () => {
	assert.deepEqual(answerChannelPayload({ custom: "ship it Friday", cancelled: false }, ["alpha", "beta"], false), {
		answers: [{ questionIndex: 0, text: "ship it Friday" }],
	});
});

T("payload: multi-select joined labels -> all indexes, authored order", () => {
	assert.deepEqual(answerChannelPayload({ value: "gamma, alpha", cancelled: false }, ["alpha", "beta", "gamma"], true), {
		answers: [{ questionIndex: 0, optionIndexes: [0, 2] }],
	});
});

T("payload: multi-select dedupes repeated labels", () => {
	assert.deepEqual(answerChannelPayload({ value: "alpha, alpha", cancelled: false }, ["alpha", "beta"], true), {
		answers: [{ questionIndex: 0, optionIndexes: [0] }],
	});
});

T("payload: unmatched value degrades to custom text (never dropped)", () => {
	assert.deepEqual(answerChannelPayload({ value: "something else", cancelled: false }, ["alpha", "beta"], false), {
		answers: [{ questionIndex: 0, text: "something else" }],
	});
});

T("payload: cancelled -> cancel flag, no answers", () => {
	assert.deepEqual(answerChannelPayload({ cancelled: true }, ["alpha", "beta"], false), { cancel: true });
});

T("payload: empty answer -> null (caller ignores, card stays)", () => {
	assert.equal(answerChannelPayload({ cancelled: false }, ["alpha", "beta"], false), null);
	assert.equal(answerChannelPayload({}, ["alpha", "beta"], true), null);
	assert.equal(answerChannelPayload(null, ["alpha", "beta"], false), null);
});

// ---- phone answer -> block reason (non-TUI intercepted path) ---------------
// In --mode rpc rpiv's own dialogs hang with no RPC client attached and its
// answer channel refuses host "rpc" (unsupported_host), so the bridge blocks
// the tool_call and returns the answer as the block reason. The envelope
// mirrors rpiv's buildQuestionnaireResponse wording so the model reads the
// answer the way it always has (response-envelope.ts).

T("reason: option answer mirrors the rpiv answered envelope", () => {
	assert.equal(
		blockedReason("Deploy now?", { value: "yes", cancelled: false }),
		'User has answered your questions: "Deploy now?"="yes". You can now continue with the user\'s answers in mind.',
	);
});

T("reason: custom text answer", () => {
	assert.equal(
		blockedReason("Q?", { custom: "do it differently", cancelled: false }),
		'User has answered your questions: "Q?"="do it differently". You can now continue with the user\'s answers in mind.',
	);
});

T("reason: multi-select joined labels", () => {
	assert.equal(
		blockedReason("Pick?", { value: "alpha, gamma", cancelled: false }),
		'User has answered your questions: "Pick?"="alpha, gamma". You can now continue with the user\'s answers in mind.',
	);
});

T("reason: cancelled mirrors rpiv's decline message", () => {
	assert.equal(blockedReason("Q?", { cancelled: true }), "User declined to answer questions");
});

// ---- tool result -> phone-card settle decision (terminal answer in) --------
// Forwarded ask tool_result events settle the matching question card
// (match by toolCallId on the phone). details is rpiv's QuestionnaireResult:
// { answers: QuestionAnswer[], cancelled: boolean }.

T("settle: option answer text from rpiv details", () => {
	const s = phoneSettleFromToolResult({
		toolName: "ask_user_question",
		isError: false,
		details: {
			answers: [{ questionIndex: 0, question: "Q?", kind: "option", answer: "yes" }],
			cancelled: false,
		},
	});
	assert.deepEqual(s, { text: "yes" });
});

T("settle: multi-select answer joins selected labels and custom text", () => {
	const s = phoneSettleFromToolResult({
		toolName: "ask_user_question",
		isError: false,
		details: {
			answers: [{ questionIndex: 0, question: "Q?", kind: "multi", answer: "and more", selected: ["alpha", "gamma"] }],
			cancelled: false,
		},
	});
	assert.deepEqual(s, { text: "alpha, gamma, and more" });
});

T("settle: several answered questions join with commas", () => {
	const s = phoneSettleFromToolResult({
		toolName: "ask_user_question",
		isError: false,
		details: {
			answers: [
				{ questionIndex: 0, question: "A?", kind: "option", answer: "x" },
				{ questionIndex: 1, question: "B?", kind: "custom", answer: "y" },
			],
			cancelled: false,
		},
	});
	assert.deepEqual(s, { text: "x, y" });
});

T("settle: declined result -> cancelled", () => {
	assert.deepEqual(
		phoneSettleFromToolResult({
			toolName: "ask_user_question",
			isError: false,
			details: { answers: [], cancelled: true },
		}),
		{ cancelled: true },
	);
});

T("settle: errored call -> cancelled", () => {
	assert.deepEqual(
		phoneSettleFromToolResult({ toolName: "ask_user_question", isError: true, details: undefined }),
		{ cancelled: true },
	);
});

T("settle: non-ask tool results -> null (ignored)", () => {
	assert.equal(phoneSettleFromToolResult({ toolName: "bash", isError: false, details: {} }), null);
	assert.equal(phoneSettleFromToolResult({ toolName: "todo", isError: false, details: {} }), null);
	assert.equal(phoneSettleFromToolResult(null), null);
});

T("settle: answered but unextractable -> empty text (card shows the check)", () => {
	assert.deepEqual(
		phoneSettleFromToolResult({ toolName: "ask_user_question", isError: false, details: { answers: [], cancelled: false } }),
		{ text: "" },
	);
});
