// pi-remote extension client — WebSocket to the hub with auto-retry.
// Zero npm deps: uses the global WebSocket provided by the host runtime (Bun).
// Frames are JSON objects built/parsed by ../shared/protocol.mjs.
import {
	A_EVENT,
	A_PONG,
	H_PING,
	H_REJECT,
	frame,
	parseFrame,
} from "../shared/protocol.mjs";

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
// Event frames (streaming deltas) are dropped when the socket falls this far behind.
const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;

export interface RemoteClientOptions {
	url: string;
	token: string;
	// Called once per successful connection; send hello here.
	onOpen?: () => void;
	// Called for every valid hub frame except ping/reject (handled internally).
	onFrame?: (f: any) => void;
	// Connection chatter for UI surfaces (status line / notification);
	// console.error stays as the fallback when a callback is unset.
	// onRetry: transient reconnect noise. onInert: fatal, non-retryable
	// rejection (bad token) — the client stops retrying after it.
	onRetry?: (msg: string) => void;
	onInert?: (msg: string) => void;
}

export class RemoteClient {
	private opts: RemoteClientOptions;
	private ws: any = null;
	private attempt = 0;
	private stopped = false;
	private rejected = false;
	private reconnectTimer: any = null;
	private droppedFrames = 0;

	constructor(opts: RemoteClientOptions) {
		this.opts = opts;
	}

	start(): void {
		if (this.stopped || this.ws) return;
		this.connect();
	}

	// Close for good: no reconnect, no timers left behind.
	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			try {
				ws.onclose = null;
				ws.onerror = null;
				ws.onmessage = null;
				ws.onopen = null;
				ws.close();
			} catch {
				// socket already gone
			}
		}
	}

	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === 1;
	}

	// Send a frame. Event frames are droppable under backpressure; returns false
	// when the frame was not sent (disconnected or dropped).
	send(type: string, payload: Record<string, unknown> = {}, opts: { droppable?: boolean } = {}): boolean {
		const ws = this.ws;
		if (!ws || ws.readyState !== 1) return false;
		if (ws.bufferedAmount > BACKPRESSURE_LIMIT_BYTES && (opts.droppable || type === A_EVENT)) {
			this.droppedFrames++;
			return false;
		}
		try {
			ws.send(JSON.stringify(frame(type, payload)));
			return true;
		} catch {
			return false;
		}
	}

	private connect(): void {
		if (this.stopped) return;
		let ws: any;
		try {
			ws = new WebSocket(this.opts.url);
		} catch (err) {
			this.scheduleReconnect(err);
			return;
		}
		this.ws = ws;
		ws.onopen = () => {
			this.attempt = 0;
			this.opts.onOpen?.();
		};
		ws.onmessage = (msg: any) => {
			const f = parseFrame(typeof msg.data === "string" ? msg.data : String(msg.data));
			if (!f) return;
			if (f.type === H_PING) {
				this.send(A_PONG, {});
				return;
			}
			if (f.type === H_REJECT) {
				// Bad token will not fix itself: go inert instead of retry-looping.
				const msg = `[pi-remote] hub rejected this machine: ${f.reason ?? "bad token"}; going inert`;
				if (this.opts.onInert) this.opts.onInert(msg);
				else console.error(msg);
				this.rejected = true;
				this.stop();
				return;
			}
			this.opts.onFrame?.(f);
		};
		ws.onerror = () => {
			// onclose always follows; nothing to do here.
		};
		ws.onclose = () => {
			if (this.ws === ws) this.ws = null;
			this.scheduleReconnect();
		};
	}

	private scheduleReconnect(cause?: unknown): void {
		if (this.stopped || this.rejected || this.reconnectTimer) return;
		const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
		this.attempt++;
		const why = cause instanceof Error ? ` (${cause.message})` : "";
		const msg = `[pi-remote] hub unreachable, retrying in ${Math.round(delay)}ms (attempt ${this.attempt})${why}`;
		// The status line updates on EVERY attempt so it never shows a stale
		// number; the headless console fallback stays throttled.
		if (this.opts.onRetry) this.opts.onRetry(msg);
		else if (this.attempt <= 3 || this.attempt % 10 === 0) console.error(msg);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}
}
