// pi-remote shared — ask-user bridge mapping (ADR 0008). Pure, zero-dependency.
// Runs on Node 22 and Bun and in the browser.
//
// pi-remote registers NO ask tool: the main rpiv extension
// (@juicesharp/rpiv-ask-user-question, tool name "ask_user_question"; matched
// defensively as /^([a-z_]*_)?ask_user_question$/) owns the tool and the
// terminal dialog. This module is the pure glue between that tool's wire
// shapes and the phone's A_QUESTION contract:
//   tool input   -> A_QUESTION payload      (questionFromToolInput)
//   phone answer -> rpiv answer-channel payload (answerChannelPayload)
//   phone answer -> intercepted-call block reason (blockedReason)
//   tool result  -> phone-card settle decision  (phoneSettleFromToolResult)
// Tool input shapes (post-decode):
//   { questions: [{ question, header?, options: [{label, description?}|string],
//                   multiSelect? }, ...] }        // canonical, up to N questions
//   { question, options: [...], multiSelect? }    // flat single-question form
// The A_QUESTION frame carries exactly ONE question, so the first usable
// question wins. Unknown shapes degrade to null; junk option entries are
// dropped; a question with zero usable options still passes (custom-answer
// path) — only a missing/empty question text yields null.

// Matches the built-in names and defensively similar variants
// ("ask_user_question", "learn_ask_user_question").
const ASK_USER_TOOL_RE = /^([a-z_]*_)?ask_user_question$/;

export function isAskUserTool(toolName) {
	return typeof toolName === "string" && ASK_USER_TOOL_RE.test(toolName);
}

function pickOptions(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const o of raw) {
		if (typeof o === "string") {
			out.push(o);
		} else if (o && typeof o === "object" && o.label !== undefined && o.label !== null) {
			const label = String(o.label);
			if (label.length > 0) out.push(label);
		}
	}
	return out;
}

function pickMultiSelect(entry, top) {
	const v = entry && typeof entry === "object" && entry.multiSelect !== undefined ? entry.multiSelect : top;
	return v === true;
}

// First usable entry: has non-empty string question text.
function firstUsable(questions) {
	if (!Array.isArray(questions)) return null;
	for (const entry of questions) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.question === "string" && entry.question.length > 0) return entry;
	}
	return null;
}

// Returns { question, options: string[], multiSelect: bool } | null.
export function extractQuestion(toolName, input) {
	if (!isAskUserTool(toolName)) return null;
	if (!input || typeof input !== "object") return null;

	let entry = null;
	if (typeof input.question === "string" && input.question.length > 0) {
		entry = input; // flat single-question form
	} else if (input.questions !== undefined) {
		entry = firstUsable(input.questions); // canonical questions-array form
	}
	if (!entry) return null;

	return {
		question: entry.question,
		options: pickOptions(entry.options),
		multiSelect: pickMultiSelect(entry, input.multiSelect),
	};
}

// ---- tool input -> A_QUESTION payload mapping (ADR 0008 bridge-in) --------

// The forwarded tool_execution_start for an ask-user tool carries the RAW model
// arguments (pi emits the event before prepareArguments runs), so the mapping
// decodes defensively itself: rpiv's models may double-encode arrays as JSON
// strings (its prepareQuestionArguments exists for exactly that). Returns
// { question, options: string[], multiSelect } for the FIRST usable question,
// or null when nothing usable is there (no card). Multi-question rendering is
// out of scope (spec): the first question surfaces.
export function questionFromToolInput(toolName, args) {
	// Multi-question calls are terminal-only: rpiv's answer channel is strict
	// all-or-nothing per call, so a phone answer covering only the first
	// question would be rejected and strand the card. No card — the rpiv
	// dialog (TUI) or a guidance block (non-TUI) owns those calls.
	if (isMultiQuestionCall(decodeAskUserArguments(args))) return null;
	return extractQuestion(toolName, decodeAskUserArguments(args));
}

// True when the decoded input carries MORE than one question (rpiv's tool
// schema allows 1–4 and its guidance encourages batching). Flat single-form
// and garbage are never multi.
export function isMultiQuestionCall(args) {
	const decoded = decodeAskUserArguments(args);
	if (!decoded || typeof decoded !== "object") return false;
	if (Array.isArray(decoded.questions)) return decoded.questions.length > 1;
	return false;
}

// ---- phone answer -> rpiv answer-channel payload (ADR 0008 bridge-out) ----

// The main rpiv extension's external answer channel (contract pinned in its
// events.ts; channels never rename):
export const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer"; // inbound: settles an open questionnaire, first answer wins
export const ASK_USER_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result"; // outbound verdict: { ok, code?, reason?, requestId?, toolCallId? }

// Builds the AskUserAnswerEventPayload BODY the bridge emits on
// ASK_USER_ANSWER_EVENT (the caller adds toolCallId and requestId). Encodes the
// phone answer the way tool/external-answer.ts accepts — strict, all-or-nothing:
//   answer:  { value?, custom?, cancelled } (H_QUESTION_ANSWER fields)
//   options: the question's option labels in authored order (indexes are 0-based)
// Returns { cancel: true } | { answers: [entry] } | null (nothing sensible —
// the caller ignores the answer and the card settles from the tool result).
// Single-select takes an option index OR text; multi-select takes indexes
// and/or text, mirroring the TUI's checked options plus its custom row.
export function answerChannelPayload(answer, options, multiSelect) {
	if (!answer || answer.cancelled === true) return answer && answer.cancelled ? { cancel: true } : null;
	const labels = Array.isArray(options) ? options : [];
	const entry = { questionIndex: 0 };
	const custom = typeof answer.custom === "string" && answer.custom.length > 0 ? answer.custom : undefined;
	// Custom text wins outright: rpiv rejects a single-select entry carrying
	// both optionIndexes and text, and the phone sends exactly one anyway.
	if (custom === undefined && typeof answer.value === "string" && answer.value.length > 0) {
		const indexes = multiSelect === true
			? multiSelectIndexes(answer.value, labels)
			: exactIndex(answer.value, labels);
		if (indexes.length > 0) entry.optionIndexes = indexes;
		else entry.text = answer.value;
	}
	if (custom !== undefined) entry.text = custom;
	if (entry.optionIndexes === undefined && entry.text === undefined) return null;
	return { answers: [entry] };
}

// 0-based indexes of the option labels named in a joined multi-select answer
// ("alpha, gamma"), matched greedily against the authored labels so labels
// containing ", " still resolve; leftover text is ignored here (the caller
// already put a custom field into entry.text when the phone sent one).
function multiSelectIndexes(value, labels) {
	const picked = [];
	let rest = value;
	for (;;) {
		rest = rest.replace(/^[,\s]+/, "");
		if (rest.length === 0) break;
		const hit = labels
			.map((label, index) => ({ label, index }))
			.filter((c) => c.label.length > 0 && rest.startsWith(c.label))
			.sort((a, b) => b.label.length - a.label.length)[0];
		if (!hit) break; // remainder is not option text; the custom field carries it
		if (!picked.includes(hit.index)) picked.push(hit.index);
		rest = rest.slice(hit.label.length);
	}
	return picked.sort((a, b) => a - b);
}

function exactIndex(value, labels) {
	const index = labels.indexOf(value);
	return index === -1 ? [] : [index];
}

// Block reason for the non-TUI intercepted path (--mode rpc with no RPC
// client: rpiv's dialog walker would hang forever and its answer channel
// refuses host "rpc", so the bridge blocks the tool_call and carries the
// answer in the block reason). Mirrors rpiv's response-envelope.ts wording so
// the model reads the answer the way it always has.
export function blockedReason(question, answer) {
	if (!answer || answer.cancelled === true) return "User declined to answer questions";
	const given = answer.custom ?? answer.value ?? "";
	return `User has answered your questions: "${question}"="${given}". You can now continue with the user's answers in mind.`;
}

// ---- tool result -> phone-card settle decision (terminal answer in) -------

// Decision for a forwarded ask-user tool_result event: what the matching
// question card shows. details is rpiv's QuestionnaireResult
// { answers, cancelled } (tool/types.ts) when its tool completed; errored or
// declined calls settle as cancelled. Returns { text } | { cancelled: true },
// or null for anything that is not an ask-user tool result. Pure: attach.mjs
// calls this; the tests import it from here.
export function phoneSettleFromToolResult(ev) {
	if (!ev || typeof ev.toolName !== "string" || !isAskUserTool(ev.toolName)) return null;
	if (ev.isError === true) return { cancelled: true };
	const details = ev.details;
	if (details && typeof details === "object" && details.cancelled === true) return { cancelled: true };
	const answers = details && Array.isArray(details.answers) ? details.answers : [];
	const parts = [];
	for (const a of answers) {
		if (!a || typeof a !== "object") continue;
		const selected = Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === "string" && s.length > 0) : [];
		if (selected.length > 0) parts.push(selected.join(", "));
		if (typeof a.answer === "string" && a.answer.length > 0) parts.push(a.answer);
	}
	return { text: parts.join(", ") };
}

// ---- replacement-tool argument decoding (kept for the bridge mapping) ------

// rpiv's models may double-encode array/object parameters as JSON strings —
// its prepareQuestionArguments (tool/normalize-params.ts) decodes questions[],
// each question's options[], and (this variant additionally) a flat stringified
// options array (learn-style input). Mirrors it for the bridge mapping.
function decodeMaybeJson(value) {
	if (typeof value !== "string") return value;
	try {
		const parsed = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" ? parsed : value;
	} catch {
		return value;
	}
}

export function decodeAskUserArguments(args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const out = { ...args };
	if (out.questions !== undefined) {
		const questions = decodeMaybeJson(out.questions);
		out.questions = Array.isArray(questions)
			? questions.map((q) => {
					const entry = decodeMaybeJson(q);
					if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
					const options = decodeMaybeJson(entry.options);
					return Array.isArray(options) ? { ...entry, options } : entry;
				})
			: questions;
	}
	if (out.options !== undefined) {
		const options = decodeMaybeJson(out.options);
		if (Array.isArray(options)) out.options = options;
	}
	return out;
}
