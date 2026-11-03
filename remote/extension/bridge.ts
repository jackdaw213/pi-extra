// pi-remote extension bridge — wires one pi session to the hub.
// Builds hello from ctx, forwards whitelisted pi events (dispatched by the
// factory-registered handlers in index.ts), derives session state, and answers
// hub commands (message/abort/stop/spawn/delete).
import { readFileSync, mkdirSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { spawn as spawnDetached } from "node:child_process";
import { homedir, hostname, networkInterfaces, platform, release } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	A_EVENT,
	A_HELLO,
	A_HISTORY,
	A_MESSAGE_RESULT,
	A_QUESTION,
	A_STATE,
	FORWARDED_PI_EVENTS,
	H_ABORT,
	H_DELETE,
	H_HISTORY_REQUEST,
	H_MESSAGE,
	H_QUESTION_ANSWER,
	H_SPAWN,
	H_STOP,
	H_WELCOME,
} from "../shared/protocol.mjs";
import {
	ASK_USER_ANSWER_EVENT,
	answerChannelPayload,
	isAskUserTool,
	questionFromToolInput,
} from "../shared/question.mjs";
import { chunkHistoryEvents, parseSessionTranscript } from "../shared/history.mjs";
import { findSessionFile } from "../shared/sessions.mjs";
import { parentSessionFromHeaderLine } from "../shared/subagent.mjs";
import { RemoteClient } from "./client";
import { handleSpawn } from "./spawn-bridge";
import { registerSendFileTool } from "./files";

export interface BridgeConfig {
	hubUrl: string;
	machineToken: string;
	machineId?: string;
	machineName?: string;
}

type SessionState = "idle" | "working" | "blocked";

// What a pending ask-user question resolves with (phone H_QUESTION_ANSWER; the
// non-TUI interception in index.ts awaits it, TUI mode never does).
export interface QuestionAnswer {
	value?: string; // tapped/selected option label (multi-select: labels joined ", ")
	custom?: string; // typed free text
	cancelled: boolean;
}

// What the bridge sends to the phone (A_QUESTION contract, unchanged):
// callId echoes back in H_QUESTION_ANSWER. options are plain labels.
export interface AskUserFrame {
	callId: string;
	toolName: string;
	question: string;
	options: string[];
	multiSelect: boolean;
}

// One open ask-user tool call, registered from the forwarded
// tool_execution_start (TUI and every mode) or by the non-TUI interception.
// Drives the blocked state, the history re-emit, and the answer-channel
// payload (options order -> optionIndexes); the waiter serves the
// non-TUI interception only.
interface OpenQuestion {
	frame: Record<string, unknown>;
	waiter?: (answer: QuestionAnswer) => void;
	/** Set when the phone answer went out on the channel; the verdict owns cleanup. */
	answered?: boolean;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		const v = fn();
		return v === undefined || v === null ? fallback : v;
	} catch {
		return fallback;
	}
}

// Like safe(), but also catches values that only become "undefined" after String().
function safeText(fn: () => unknown, fallback: string): string {
	try {
		const v = fn();
		return v === undefined || v === null ? fallback : String(v);
	} catch {
		return fallback;
	}
}

function sanitizeName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "file";
	return base.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
}

// --- process-wide bridge registry ------------------------------------------
//
// Each pi session runtime evaluates this module fresh, so module state is NOT
// shared between a session and its in-process subagents — but globalThis is.
// Subagent sessions stay inert (no bridge of their own, ADR: they must never
// appear in the dashboard list), yet their ask-user questions must still
// surface in the parent's phone UI. A subagent therefore looks up the parent
// session's bridge here and routes its A_QUESTION through it.
const BRIDGE_REGISTRY = Symbol.for("pi-remote.activeBridges");

function bridgeRegistry(): Map<SessionBridge, string> {
	const g = globalThis as any;
	if (!(g[BRIDGE_REGISTRY] instanceof Map)) g[BRIDGE_REGISTRY] = new Map();
	return g[BRIDGE_REGISTRY];
}

function trackBridge(b: SessionBridge): void {
	try {
		bridgeRegistry().set(b, b.sessionId);
	} catch {
		// registry is best-effort; without it subagent questions degrade to decline
	}
}

function untrackBridge(b: SessionBridge): void {
	try {
		bridgeRegistry().delete(b);
	} catch {
		// ignore
	}
}

// The bridge owning `sessionId`, when still connected to a live session.
export function findBridge(sessionId: unknown): SessionBridge | null {
	if (typeof sessionId !== "string" || sessionId.length === 0) return null;
	let found: SessionBridge | null = null;
	for (const [b, sid] of bridgeRegistry()) {
		if (sid === sessionId && !b.isClosed) found = b;
	}
	return found;
}

// The most recently started live bridge in this process — the parent session
// for a subagent tool call (subagents spawn from the current main session;
// during a /new–/resume overlap the newest wins, which is the incoming one).
export function anyActiveBridge(): SessionBridge | null {
	const entries = [...bridgeRegistry().entries()].filter(([, sid]) => sid !== "");
	for (let i = entries.length - 1; i >= 0; i--) {
		if (!entries[i][0].isClosed) return entries[i][0];
	}
	return null;
}

// --- subagent detection signals (feature: subagents never reach the hub) ----

export interface SubagentSignals {
	parentSession?: string;
	name?: string;
	reason?: string;
}

// Gathers the detection signals defensively from the session_start context.
// parentSession: pi exposes no accessor for the session header, so read the
// in-memory header (sessionManager.fileEntries[0] — present even before the
// file is flushed, which happens only after the first message); fall back to
// the file's first JSON line for runtimes where the property is absent.
export function subagentSignals(ctx: any, reason: unknown): SubagentSignals {
	const sm = ctx?.sessionManager;
	let parentSession = safe(() => sm?.fileEntries?.[0]?.parentSession, undefined);
	if (parentSession === undefined || parentSession === null) {
		const file = safe(() => sm?.getSessionFile?.(), undefined);
		if (typeof file === "string" && file.length > 0) {
			parentSession = parentSessionFromHeaderLine(firstSessionFileLine(file));
		}
	}
	const name = safe(() => sm?.getSessionName?.(), undefined);
	return {
		parentSession: typeof parentSession === "string" && parentSession.length > 0 ? parentSession : undefined,
		name: typeof name === "string" && name.length > 0 ? name : undefined,
		reason: typeof reason === "string" ? reason : undefined,
	};
}

// First line of a session file, or undefined when absent/unreadable. Reads at
// most 4 KiB: new sessions are not flushed until the first message, so this
// usually finds nothing at session_start — it is a fallback, not the main path.
function firstSessionFileLine(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(4096);
		const n = readSync(fd, buf, 0, 4096, 0);
		const text = buf.toString("utf8", 0, n);
		const nl = text.indexOf("\n");
		return (nl === -1 ? text : text.slice(0, nl)).trim();
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
	}
}

function buildMachine(machineId?: string, machineName?: string) {
	let id = machineId?.trim() || "";
	if (!id) {
		try {
			id = readFileSync("/etc/machine-id", "utf8").trim();
		} catch {
			// fall through to a random id
		}
	}
	if (!id) id = randomUUID();
	const addresses: string[] = [];
	for (const infos of Object.values(networkInterfaces())) {
		for (const info of infos ?? []) {
			if (info.family === "IPv4" && !info.internal) addresses.push(info.address);
		}
	}
	return {
		id,
		hostname: hostname(),
		name: machineName || "",
		os: platform(),
		release: release(),
		addresses,
	};
}

export class SessionBridge {
	readonly sessionId: string;
	private readonly pi: any;
	private readonly ctx: any;
	private readonly machineToken: string;
	private readonly machine: ReturnType<typeof buildMachine>;
	private readonly mode: "terminal" | "remote";
	private readonly startedAt: string;
	private client: RemoteClient;
	private seq = 0;
	private agentActive = false; // agent_start .. agent_settled
	private promptOpen = false; // ui_prompt_start .. ui_prompt_end
	// Ask-user tool calls open on the phone right now: callId (pi's toolCallId)
	// -> open question. Registered from the forwarded tool_execution_start (the
	// bridge-in mapping, TUI and every mode) and kept until the call settles —
	// an answered questionnaire is removed when the answer goes out, and any
	// straggler goes when the tool result/end event or the agent settle arrives.
	// The frame is kept so a phone attaching later (history_request) can be
	// shown the still-pending question instead of a silently blocked session.
	private openQuestions = new Map<string, OpenQuestion>();
	private lastState: SessionState | null = null;
	private closed = false;
	private historyBusy = false; // one replay at a time — chunk streams must not interleave
	private historyQueued = false; // a request that arrived while busy reruns after

	constructor(pi: any, ctx: any, cfg: BridgeConfig) {
		this.pi = pi;
		this.ctx = ctx;
		this.machineToken = cfg.machineToken;
		this.sessionId = safe(() => String(ctx.sessionManager.getSessionId()), randomUUID());
		this.machine = buildMachine(cfg.machineId, cfg.machineName);
		this.mode = ctx.mode === "tui" ? "terminal" : "remote";
		this.startedAt = new Date().toISOString();
		trackBridge(this);
		this.client = new RemoteClient({
			url: cfg.hubUrl,
			token: cfg.machineToken,
			onOpen: () => this.client.send(A_HELLO, { machine: this.machine, session: this.session(), token: this.machineToken }),
			onFrame: (f) => this.handleFrame(f),
			onRetry: (msg) => this.uiRetry(msg),
			onInert: (msg) => {
				this.uiClearStatus();
				this.uiNotify(msg, "error");
			},
		});
		this.client.start();
		registerSendFileTool(pi, {
			send: (type, payload) => this.client.send(type, payload),
			getSessionId: () => this.sessionId,
		});
	}

	// --- UI reporting (TUI footer / RPC client) ------------------------------
	// Raw console.error lines overprint the composer in terminal sessions, so
	// connection chatter and failures go through pi's UI instead. Every UI call
	// is guarded by ctx.hasUI and wrapped in try/catch: reporting must never
	// take the bridge or the connection loop down, and headless contexts (no
	// UI) keep the console.error fallback.

	private uiNotify(msg: string, kind: "info" | "warning" | "error" = "error"): void {
		try {
			if (this.ctx?.hasUI) {
				this.ctx.ui.notify(msg, kind);
				return;
			}
		} catch {
			// notification is best-effort; the console still gets the message
		}
		console.error(msg);
	}

	// Transient reconnect noise: one short status line, attempt number included.
	private uiRetry(msg: string): void {
		const attempt = /attempt (\d+)/.exec(msg)?.[1] ?? "?";
		try {
			if (this.ctx?.hasUI) {
				this.ctx.ui.setStatus(`pi-remote: hub unreachable (attempt ${attempt})`);
				return;
			}
		} catch {
			// status is best-effort; the console still gets the message
		}
		console.error(msg);
	}

	// The hub connection actually works again (or went inert for good):
	// stale retry chatter in the status line is obsolete.
	private uiClearStatus(): void {
		try {
			if (this.ctx?.hasUI) this.ctx.ui.setStatus("");
		} catch {
			// status is best-effort
		}
	}

	private session() {
		return {
			id: this.sessionId,
			name: safeText(() => this.ctx.sessionManager.getSessionName(), ""),
			cwd: safeText(() => this.ctx.sessionManager.getCwd(), ""),
			model: safe(() => this.ctx.model?.id ?? null, null),
			thinkingLevel: safe(() => this.ctx.thinkingLevel ?? null, null),
			state: this.currentState(),
			pid: process.pid,
			mode: this.mode,
			kind: this.kind,
			startedAt: this.startedAt,
		};
	}

	// Session kind per ADR 0006. The spawner injects PI_REMOTE_SESSION_KIND via
	// systemd (shared/spawn.mjs); a valid value wins. Terminal sessions are
	// keepers by definition and never report temp, whatever a stale environment
	// says. Remote sessions without a valid value are temp (the spawn default).
	private get kind(): "temp" | "normal" {
		if (this.mode === "terminal") return "normal";
		const k = process.env.PI_REMOTE_SESSION_KIND;
		return k === "temp" || k === "normal" ? k : "temp";
	}

	// Called by the factory-registered forwarding handlers. Synchronous, no awaits.
	forward(ev: string, event: unknown): void {
		if (this.closed) return;
		const payload = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
		// tool_result events exist on the wire for the todo panel's snapshot and
		// for settling ask-user question cards (terminal answered or declined);
		// every other tool's full result would be dead bandwidth to all phones
		// (results already reach the transcript/history paths).
		if (ev === "tool_result" && payload.toolName !== "todo" && !isAskUserTool(payload.toolName)) return;
		// Ask-user bridge-in (ADR 0008): the forwarded tool_execution_start for an
		// ask tool carries the questions in its raw args — map them onto the
		// existing A_QUESTION frame. Phone contract unchanged; callId is pi's real
		// toolCallId, echoed back in H_QUESTION_ANSWER.
		if (ev === "tool_execution_start" && isAskUserTool(payload.toolName)) {
			const q = questionFromToolInput(payload.toolName, payload.args);
			if (q) this.beginAskQuestion({ callId: String(payload.toolCallId ?? ""), toolName: String(payload.toolName), ...q });
		}
		// Settle the open question when the call ends without a phone answer —
		// the terminal answered (TUI: tool_result fires first and settles the
		// card), the call errored, or the run aborted. tool_execution_end is the
		// backstop; pi emits it for every finalized call.
		if ((ev === "tool_result" || ev === "tool_execution_end") && isAskUserTool(payload.toolName)) {
			const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
			if (callId && this.openQuestions.delete(callId)) this.sendState();
		}
		this.client.send(A_EVENT, { sessionId: this.sessionId, seq: ++this.seq, ev: { type: ev, ...payload } }, { droppable: true });
	}

	agentStart(): void {
		if (this.closed) return;
		this.agentActive = true;
		this.sendState();
	}

	agentSettled(event?: { aborted?: boolean }): void {
		if (this.closed) return;
		this.agentActive = false;
		// A question still open at settle time means the run ended under it
		// (abort); nobody will consume the answer — release the waiters.
		if (this.openQuestions.size > 0) this.closeOpenQuestions();
		void event;
	}

	// --- ask-user bridge (ADR 0008) --------------------------------------------
	//
	// pi-remote registers NO ask tool: the main rpiv extension owns the tool and
	// the terminal dialog. The bridge is a second surface: the phone card comes
	// from the forwarded tool_execution_start (above), and a phone answer is
	// delivered through rpiv's external answer channel (rpiv:ask-user:answer),
	// which settles the open questionnaire — first answer wins — and closes the
	// terminal dialog. In TUI mode rpiv's own tool_result (forwarded above)
	// settles the phone card when the terminal answered instead. In --mode rpc
	// with no RPC client rpiv's own dialogs would hang forever and its answer
	// channel refuses host "rpc" (unsupported_host), so index.ts intercepts the
	// tool_call in every non-TUI mode and awaits the phone answer here.

	// Register (idempotently) and render one open ask-user question. Called from
	// forward() on the mapped tool_execution_start, and from index.ts's
	// interception for inert-subagent questions whose start event never reaches
	// this bridge's forwarder. Works for nested calls: the subagent routes
	// through the process-wide registry, so the question carries THIS session's
	// id and the phone answers it under the parent chat (round-5 registry
	// behavior, unchanged).
	beginAskQuestion(frame: AskUserFrame): void {
		if (this.closed || !frame.callId || this.openQuestions.has(frame.callId)) return;
		this.openQuestions.set(frame.callId, { frame: { sessionId: this.sessionId, ...frame } });
		this.sendState(); // open question => blocked
		this.client.send(A_QUESTION, { sessionId: this.sessionId, ...frame });
	}

	// The non-TUI interception waits for the phone here. Registers the question
	// first when needed (inert subagent: its start event was not forwarded), so
	// the card exists before the wait begins. No timeout: abort is the escape
	// hatch (ctx.signal in the interception, agent_settled, close).
	awaitPhoneAnswer(frame: AskUserFrame): Promise<QuestionAnswer> {
		this.beginAskQuestion(frame);
		const entry = this.openQuestions.get(frame.callId);
		if (!entry) return Promise.resolve({ cancelled: true });
		return new Promise<QuestionAnswer>((resolve) => {
			entry.waiter = resolve;
		});
	}

	// Verdict for an answer the bridge sent on rpiv:ask-user:answer. ok: done —
	// the tool completes and the transcript records rpiv's own success result;
	// the forwarded tool_result settles the phone card. Rejected (e.g. the
	// terminal answered first): nothing — the same settle path applies. Either
	// way this question can take no further answers.
	askAnswerResult(payload: unknown): void {
		const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
		const callId = typeof p.toolCallId === "string" ? p.toolCallId : "";
		if (!callId || !this.openQuestions.has(callId)) return;
		this.openQuestions.delete(callId);
		this.sendState(); // leaves blocked -> any second phone card stands down
	}

	// True while the session runtime this bridge belongs to is alive. Registry
	// consumers (findBridge/anyActiveBridge) skip closed bridges.
	get isClosed(): boolean {
		return this.closed;
	}

	// Run end/abort/close: no answer can be consumed anymore. Resolve
	// interception waiters cancelled; the cards stand down via the state flip.
	private closeOpenQuestions(): void {
		const open = [...this.openQuestions.values()];
		this.openQuestions.clear();
		for (const { waiter } of open) waiter?.({ cancelled: true });
		this.sendState();
	}

	promptOpened(): void {
		if (this.closed) return;
		this.promptOpen = true;
		this.sendState();
	}

	promptClosed(): void {
		if (this.closed) return;
		this.promptOpen = false;
		this.sendState();
	}

	private currentState(): SessionState {
		if (this.promptOpen || this.openQuestions.size > 0) return "blocked";
		if (this.agentActive) return "working";
		return "idle";
	}

	private sendState(force = false): void {
		const state = this.currentState();
		if (!force && state === this.lastState) return;
		this.lastState = state;
		this.client.send(A_STATE, { sessionId: this.sessionId, state });
	}

	private handleFrame(f: any): void {
		switch (f.type) {
			case H_WELCOME:
				// Hello accepted: connected and authenticated, so retry chatter
				// in the status line is obsolete. Also re-assert the real state:
				// the hello above was built before this point and a reconnect
				// resets the hub's picture — the dedupe in sendState() would
				// otherwise leave a stale state (e.g. "idle" mid-run) forever.
				this.uiClearStatus();
				this.sendState(true);
				break;
			case H_MESSAGE:
				void this.handleMessage(f);
				break;
			case H_ABORT:
				try {
					this.ctx.abort();
				} catch (err) {
					this.uiNotify(`[pi-remote] abort failed: ${errText(err)}`);
				}
				break;
			case H_STOP:
				// Remote (phone-spawned) sessions may be shut down from the phone;
				// terminal sessions must survive it.
				if (this.mode === "remote") this.shutdownRemoteSession();
				break;
			case H_DELETE:
				// Swipe-to-delete (ADR 0006): stops ANY mode — this deliberately
				// relaxes the "terminal sessions survive stop" rule for the delete
				// path only. H_STOP semantics above stay untouched.
				void this.handleDelete(f);
				break;
			case H_SPAWN:
				void handleSpawn(this.client, f);
				break;
			case H_HISTORY_REQUEST:
				void this.handleHistoryRequest(f);
				break;
			case H_QUESTION_ANSWER: {
				// The phone answered a question card (ADR 0008). Deliver through
				// rpiv's external answer channel (first answer wins; the requestId
				// pairs the verdict on rpiv:ask-user:answer-result), and release the
				// non-TUI interception waiter when one is waiting. Unknown or
				// already-settled questions are ignored — the card then settles from
				// the forwarded tool result / end event instead.
				const callId = typeof f.callId === "string" ? f.callId : "";
				const entry = callId ? this.openQuestions.get(callId) : undefined;
				if (!entry || entry.answered) break;
				const answer: QuestionAnswer = {
					value: typeof f.value === "string" ? f.value : undefined,
					custom: typeof f.custom === "string" ? f.custom : undefined,
					cancelled: f.cancelled === true,
				};
				// The verdict (rpiv:ask-user:answer-result) owns cleanup: deleting
				// here would strand the card when rpiv rejects the answer (e.g. the
				// terminal answered first) — the forwarded tool_result settles it.
				entry.answered = true;
				const frame = entry.frame as Record<string, unknown>;
				const body = answerChannelPayload(answer, frame.options as string[], frame.multiSelect === true);
				if (body) {
					const requestId = randomUUID();
					this.pi.events?.emit?.(ASK_USER_ANSWER_EVENT, { toolCallId: callId, requestId, ...body });
				}
				entry.waiter?.(answer); // non-TUI interception (no rpiv questionnaire open)
				break;
			}
			default:
				break; // unknown types ignored
		}
	}

	// Stop a remote (phone-spawned, --mode rpc) session for real. pi's RPC
	// loop only re-checks the extension shutdown flag after the next stdin
	// command or an agent_settled event, and phone-spawned sessions have a
	// stdin pipe that never closes and no RPC client — so ctx.shutdown() alone
	// leaves an IDLE session alive forever: a zombie the hub keeps listing
	// (the phone card pops back after the optimistic delete animation) and
	// whose temp transcript the erase watcher would eventually remove under
	// the still-running process. Abort any active run first so a busy session
	// settles into pi's deferred shutdown promptly, then, when idle, exit
	// explicitly after a short grace that lets the socket flush.
	private shutdownRemoteSession(): void {
		try {
			this.ctx.abort?.();
		} catch {
			/* idle abort is a no-op; keep going */
		}
		try {
			this.ctx.shutdown();
		} catch (err) {
			this.uiNotify(`[pi-remote] shutdown failed: ${errText(err)}`);
			return;
		}
		this.spawnUnitCleanupWatcher();
		if (typeof this.ctx.isIdle === "function" && this.ctx.isIdle()) {
			setTimeout(() => process.exit(0), 250);
		}
	}

	// Phone-spawned sessions run as `sh -c 'sleep infinity | exec pi ...'` in a
	// transient unit: the unit's main pid is the pipeline sh, which waits on
	// `sleep infinity` even after pi has exited — without help the unit (and
	// the sleep) outlive the session forever. Detached watcher: once the pi
	// pid is gone, stop the unit (the control-group kill ends sh and sleep;
	// --collect removes it). Best effort: if the manager cannot be reached the
	// unit lingers until reboot, exactly as before.
	private spawnUnitCleanupWatcher(): void {
		let unit = "";
		try {
			const line = readFileSync("/proc/self/cgroup", "utf8")
				.split("\n")
				.find((l) => l.startsWith("0::"));
			unit = line?.trim().split("/").pop() || "";
		} catch {
			/* no cgroup file: not systemd-run, nothing to clean */
		}
		// Only transient systemd-run units (shared/spawn.mjs) get this shape.
		if (!/^run-p.*\.service$/.test(unit)) return;
		const script =
			'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; '
			+ 'systemctl --user stop "$2" 2>/dev/null || true';
		try {
			const child = spawnDetached(
				"sh",
				["-c", script, "sh", String(process.pid), unit],
				{ detached: true, stdio: "ignore" }
			);
			child.unref();
		} catch (err) {
			this.uiNotify(`[pi-remote] unit cleanup watcher failed: ${errText(err)}`);
		}
	}

	// Delete (ADR 0006): stop the session; when erase is true, also remove its
	// transcript — only for temp sessions (defense in depth; the hub validates
	// the registry kind too, but this side owns the filesystem). Terminal
	// sessions keep plain ctx.shutdown() (pi's TUI mode exits immediately when
	// idle and defers mid-run); remote sessions get the RPC-safe path above.
	private async handleDelete(f: any): Promise<void> {
		if (typeof f.sessionId === "string" && f.sessionId !== this.sessionId) {
			this.uiNotify(`[pi-remote] delete is for session ${f.sessionId}, not ${this.sessionId}; ignoring`);
			return;
		}
		const erase = f.erase === true;
		if (erase && this.kind !== "temp") {
			this.uiNotify(
				`[pi-remote] delete refused: erase requested for ${this.kind} session ${this.sessionId} (only temp sessions erase)`
			);
			return;
		}
		if (erase) this.spawnEraseWatcher();
		if (this.mode === "remote") {
			this.shutdownRemoteSession();
			return;
		}
		try {
			this.ctx.shutdown();
		} catch (err) {
			this.uiNotify(`[pi-remote] shutdown failed: ${errText(err)}`);
		}
	}

	// Erase must happen AFTER this process exits, so the watcher is a detached
	// sh that waits for the pi pid to disappear, then removes the transcript and
	// the session's remote inbox (temp means everything goes). No timeout cap:
	// a cap would erase the transcript under a session that failed to exit
	// (blank chat on attach). If the process never dies or the machine
	// reboots first, the files simply survive — keeping data is the safe
	// failure mode for an erase.
	private spawnEraseWatcher(): void {
		const pid = String(process.pid);
		const inboxDir = join(homedir(), ".pi", "remote", "inbox", this.sessionId);
		void this.resolveTranscriptPath()
			.then((file) => {
				// "sh -c <script> sh <pid> <file> <inbox>" — positional params keep
				// quoting safe for paths with spaces. rm runs even when no transcript
				// file was located, so the inbox never outlives a temp session.
				const script =
					'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; '
					+ '[ -n "$2" ] && rm -f -- "$2"; rm -rf -- "$3"';
				const child = spawnDetached(
					"sh",
					["-c", script, "sh", pid, file ?? "", inboxDir],
					{ detached: true, stdio: "ignore" }
				);
				child.unref();
			})
			.catch((err) => this.uiNotify(`[pi-remote] erase watcher failed: ${errText(err)}`));
	}

	// Transcript path: the session manager getter when the runtime exposes one,
	// otherwise the newest <timestamp>_<sessionId>.jsonl under ~/.pi/agent/sessions.
	private async resolveTranscriptPath(): Promise<string | null> {
		const sm = this.ctx?.sessionManager;
		const direct = safe(
			() => sm?.getSessionFilePath?.() ?? sm?.getSessionFile?.() ?? null,
			null as string | null
		);
		if (typeof direct === "string" && direct.length > 0) return direct;
		try {
			return await findSessionFile(this.sessionId);
		} catch {
			return null;
		}
	}

	private async handleMessage(f: any): Promise<void> {
		const ref = f.ref;
		try {
			if (typeof f.sessionId === "string" && f.sessionId !== this.sessionId) {
				throw new Error(`frame is for session ${f.sessionId}, not ${this.sessionId}`);
			}
			const attachments = Array.isArray(f.attachments) ? f.attachments : [];
			const savedPaths: string[] = [];
			const images: any[] = [];
			for (const att of attachments) {
				const dir = join(homedir(), ".pi", "remote", "inbox", this.sessionId);
				mkdirSync(dir, { recursive: true });
				const name = sanitizeName(typeof att?.name === "string" ? att.name : "file");
				const path = join(dir, `${Date.now()}-${name}`);
				writeFileSync(path, Buffer.from(String(att?.b64 ?? ""), "base64"));
				savedPaths.push(path);
				if (typeof att?.mime === "string" && att.mime.startsWith("image/")) {
					images.push({ type: "image", data: att.b64, mimeType: att.mime });
				}
			}
			let text = typeof f.text === "string" ? f.text : "";
			for (const path of savedPaths) text += `${text ? "\n" : ""}- attached file (saved): ${path}`;
			this.deliver(text, images, f.deliverAs);
			this.client.send(A_MESSAGE_RESULT, { sessionId: this.sessionId, ref, ok: true });
		} catch (err) {
			this.client.send(A_MESSAGE_RESULT, { sessionId: this.sessionId, ref, ok: false, error: errText(err) });
		}
	}

	// History replay (phone UI spec): the phone asks via POST /api/history;
	// the hub routes history_request here. We read our own session file, map it
	// to replay events (shared/history.mjs), and stream A_HISTORY chunks in
	// order. Never auto-sent. A missing/unreadable file answers chunkTotal 0.
	private async handleHistoryRequest(f: any): Promise<void> {
		if (this.historyBusy) {
			this.historyQueued = true; // rerun the queued request once idle (same frame)
			return;
		}
		this.historyBusy = true;
		try {
			if (typeof f.sessionId === "string" && f.sessionId !== this.sessionId) {
				this.uiNotify(`[pi-remote] history request is for session ${f.sessionId}, not ${this.sessionId}; ignoring`);
				return;
			}
			const text = await this.readSessionFileText();
			const chunks = chunkHistoryEvents(text === null ? [] : parseSessionTranscript(text));
			for (const chunk of chunks) {
				this.client.send(A_HISTORY, { sessionId: this.sessionId, ...chunk });
			}
			// A phone attaching to an already-blocked session must still see the
			// pending question: re-emit whatever is open right after the history
			// chunks so the card lands below the replayed transcript.
			for (const { frame } of this.openQuestions.values()) {
				this.client.send(A_QUESTION, frame);
			}
		} catch (err) {
			this.uiNotify(`[pi-remote] history replay failed: ${errText(err)}`);
			// Answer "no history" rather than leave the phone waiting for chunks.
			this.client.send(A_HISTORY, { sessionId: this.sessionId, chunkIndex: 0, chunkTotal: 0, events: [] });
		} finally {
			this.historyBusy = false;
			if (this.historyQueued) {
				this.historyQueued = false;
				void this.handleHistoryRequest(f);
			}
		}
	}

	// Returns the transcript text, or null when there is no (readable) file.
	private async readSessionFileText(): Promise<string | null> {
		const path = await this.resolveSessionFilePath();
		if (!path) return null;
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}

	// SPEC §7 names sessionManager.getSessionFile; pi docs do not guarantee it,
	// so fall back to scanning ~/.pi/agent/sessions by session id.
	private async resolveSessionFilePath(): Promise<string | null> {
		const direct = safe(() => this.ctx.sessionManager.getSessionFile(), null);
		if (typeof direct === "string" && direct.length > 0) return direct;
		try {
			return await findSessionFile(this.sessionId);
		} catch {
			return null;
		}
	}

	// sendUserMessage throws when streaming without deliverAs: idle sessions get
	// a plain turn, busy ones always steer/followUp.
	private deliver(text: string, images: any[], deliverAs: unknown): void {
		const as = deliverAs === "followUp" ? "followUp" : "steer";
		if (images.length > 0) {
			const content = [{ type: "text", text }, ...images];
			if (this.ctx.isIdle()) this.pi.sendUserMessage(content);
			else this.pi.sendUserMessage(content, { deliverAs: as });
		} else {
			if (this.ctx.isIdle()) this.pi.sendUserMessage(text);
			else this.pi.sendUserMessage(text, { deliverAs: as });
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		untrackBridge(this);
		// Session dying mid-question: release waiters so the pi run unwinds.
		if (this.openQuestions.size > 0) this.closeOpenQuestions();
		this.client.stop();
	}
}

export function startBridge(pi: any, ctx: any, cfg: BridgeConfig): SessionBridge {
	return new SessionBridge(pi, ctx, cfg);
}
