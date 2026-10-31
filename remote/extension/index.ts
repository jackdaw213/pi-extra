// pi-remote extension — loads in every pi session, connects out to the hub,
// and bridges the phone to this session. Zero npm dependencies.
//
// Factory purity: this function only registers handlers and tools. Sockets and
// timers start in session_start, and only when a config file is present.
//
// Ask-user bridge (ADR 0008, supersedes ADR 0007): pi-remote registers NOTHING
// ask-related and intercepts nothing in TUI mode — the main rpiv extension
// (@juicesharp/rpiv-ask-user-question) is THE ask tool, its terminal dialog is
// native and never blocks the composer. A registration collision is therefore
// impossible by construction. pi-remote is a bridge:
//   - bridge-in:  the forwarded tool_execution_start for an ask-user tool maps
//     the call input onto the existing A_QUESTION frame (bridge.ts), so the
//     question shows on the phone while the terminal dialog is open;
//   - bridge-out: a phone answer is emitted on rpiv's external answer channel
//     (rpiv:ask-user:answer), which settles the open questionnaire — first
//     answer wins — and closes the terminal dialog;
//   - settle:     ask-user tool_result events are forwarded so a terminal
//     answer settles the phone card;
//   - non-TUI only (--mode rpc without an RPC client): rpiv's dialog walker
//     would hang forever on an extension_ui_request nobody answers and its
//     answer channel refuses host "rpc" (unsupported_host), so the tool_call
//     below is blocked and the phone answer rides the block reason. There is
//     no terminal to lock in those modes. In TUI mode NEVER intercepted.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FORWARDED_PI_EVENTS } from "../shared/protocol.mjs";
import {
	ASK_USER_ANSWER_RESULT_EVENT,
	blockedReason,
	isAskUserTool,
	isMultiQuestionCall,
	questionFromToolInput,
} from "../shared/question.mjs";
import { isSubagentSession } from "../shared/subagent.mjs";
import {
	anyActiveBridge,
	findBridge,
	subagentSignals,
	type AskUserFrame,
	type QuestionAnswer,
	SessionBridge,
	startBridge,
} from "./bridge";

interface RemoteConfig {
	hubUrl?: string;
	machineToken?: string;
	machineId?: string;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Session-start reporting before a bridge exists (config problems, start
// failure, subagent inert notice): notify through pi's UI when one is present,
// console otherwise. Raw console.error lines overprint the composer in terminal
// sessions. UI calls are wrapped in try/catch: reporting must never break
// session startup.
function uiNotify(ctx: any, msg: string): void {
	try {
		if (ctx?.hasUI) {
			ctx.ui.notify(msg, "error");
			return;
		}
	} catch {
		// notification is best-effort; the console still gets the message
	}
	console.error(msg);
}

function loadConfig(notify: (msg: string) => void): RemoteConfig | null {
	const path = process.env.PI_REMOTE_CONFIG || join(homedir(), ".pi", "remote", "config.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		notify(`[pi-remote] no config at ${path}; extension stays inert`);
		return null;
	}
	try {
		const cfg = JSON.parse(raw) as RemoteConfig;
		if (!cfg || typeof cfg.hubUrl !== "string" || !cfg.hubUrl || typeof cfg.machineToken !== "string" || !cfg.machineToken) {
			notify(`[pi-remote] config at ${path} lacks hubUrl/machineToken; extension stays inert`);
			return null;
		}
		return cfg;
	} catch {
		notify(`[pi-remote] config at ${path} is not valid JSON; extension stays inert`);
		return null;
	}
}

export default function piRemoteExtension(pi: any): void {
	let current: SessionBridge | null = null;

	// Event forwarding — registered once; each session's bridge receives
	// dispatches through `current` until it is closed.
	for (const ev of FORWARDED_PI_EVENTS) {
		pi.on(ev, (event: unknown) => current?.forward(ev, event));
	}
	pi.on("agent_start", () => current?.agentStart());
	pi.on("agent_settled", (event: any) => current?.agentSettled(event));
	pi.on("ui_prompt_start", () => current?.promptOpened());
	pi.on("ui_prompt_end", () => current?.promptClosed());

	// Ask-user bridge-out (ADR 0008): verdicts for the answers the bridge
	// delivers on rpiv:ask-user:answer. ok → done, the tool completes and the
	// transcript records rpiv's own success result; rejected (e.g. the terminal
	// answered first, or no questionnaire is open in this runtime) → nothing,
	// the forwarded tool_result settles the phone card instead. Either way the
	// bridge must stop offering the question to the phone.
	try {
		pi.events?.on?.(ASK_USER_ANSWER_RESULT_EVENT, (payload: unknown) => current?.askAnswerResult(payload));
	} catch {
		// no event bus (unexpected): the bridge still works, verdict tracking off
	}

	// Ask-user interception — NON-TUI MODES ONLY. In TUI mode rpiv owns the
	// tool call and its native dialog; intercepting there would lock the
	// terminal (the round-5 objection). In --mode rpc (our phone-spawned
	// sessions) rpiv routes to its dialog walker, whose select/input dialogs
	// pend forever on an extension_ui_request when no RPC client is attached,
	// and its answer channel refuses host "rpc" (unsupported_host) — the phone
	// could never answer. There is no terminal to lock in those modes, so the
	// call is blocked and the phone answer rides the block reason (the model
	// reads the same answered envelope it always has).
	pi.on("tool_call", async (event: any, ctx: any): Promise<any> => {
		if (!event || ctx?.mode === "tui" || !isAskUserTool(event.toolName)) return undefined;
		const q = questionFromToolInput(event.toolName, event.input);
		if (!q) {
			// Multi-question calls: the phone answers one question at a time
			// (rpiv's channel is all-or-nothing per call). Decline with guidance
			// instead of hanging — the model re-asks as a single question, which
			// then gets a card. Unparseable input falls through to rpiv's own
			// validation, which reports the real problem.
			if (isMultiQuestionCall(event.input)) {
				return {
					block: true,
					reason: 'User is on a phone: ask ONE question per ask_user_question call. Re-ask your questions one at a time.',
				};
			}
			return undefined; // unparseable: rpiv's own validation reports the real problem
		}
		// The bridge of this session when one exists; an inert subagent session
		// has none and routes through the parent's bridge (process-wide
		// registry), so its questions surface in the parent's phone UI.
		const bridge: SessionBridge | null = findBridge(ctx?.sessionManager?.getSessionId()) ?? anyActiveBridge();
		if (!bridge || bridge.isClosed) {
			// No hub connection (headless run, dead parent): nobody can answer.
			// Decline instead of hanging.
			return { block: true, reason: blockedReason(q.question, { cancelled: true }) };
		}
		const frame: AskUserFrame = {
			callId: String(event.toolCallId ?? ""),
			toolName: String(event.toolName),
			question: q.question,
			options: q.options,
			multiSelect: q.multiSelect,
		};
		// First answer wins. Abort resolves cancelled; the loop then sees the
		// aborted signal and reports the abort itself.
		const answer: QuestionAnswer = await new Promise<QuestionAnswer>((resolve) => {
			let done = false;
			const signal: AbortSignal | undefined = ctx?.signal;
			const finish = (a: QuestionAnswer) => {
				if (done) return;
				done = true;
				try {
					signal?.removeEventListener("abort", onAbort);
				} catch {
					// ignore
				}
				resolve(a);
			};
			const onAbort = () => finish({ cancelled: true });
			bridge.awaitPhoneAnswer(frame).then(finish);
			if (signal?.aborted) finish({ cancelled: true });
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		return { block: true, reason: blockedReason(q.question, answer) };
	});

	pi.on("session_start", (event: any, ctx: any) => {
		try {
			// Subagent sessions (in-process) must never reach the hub as sessions
			// of their own: stay inert, activity keeps flowing to the phone through
			// the parent session's events and bridge. This is routine, expected
			// behavior — visible only in headless logs, never as terminal noise.
			if (isSubagentSession(subagentSignals(ctx, event?.reason))) {
				if (ctx?.mode !== "tui") {
					console.error(
						`[pi-remote] subagent session detected${typeof event?.reason === "string" ? ` (reason ${event.reason})` : ""}; extension stays inert for it`,
					);
				}
				return;
			}
			const cfg = loadConfig((msg) => uiNotify(ctx, msg));
			if (!cfg) return;
			current?.close();
			current = startBridge(pi, ctx, {
				hubUrl: cfg.hubUrl!,
				machineToken: cfg.machineToken!,
				machineId: cfg.machineId,
				machineName: (cfg as any).name,
			});
		} catch (err) {
			uiNotify(ctx, `[pi-remote] failed to start: ${errMessage(err)}`);
		}
	});

	pi.on("session_shutdown", (event: any, ctx: any) => {
		if (!current) return;
		const reason = typeof event?.reason === "string" ? event.reason : "unknown";
		current.close();
		current = null;
		// "quit": the process (and socket) dies here, nothing to report. For
		// new/resume/fork/reload the next session_start re-registers with the hub.
		if (reason !== "quit") uiNotify(ctx, `[pi-remote] session ${reason}: hub connection closed, will re-register`);
	});
}
