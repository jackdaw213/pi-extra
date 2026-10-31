// Push channel: WebSocket to ws(s)://<origin>/ws with reconnect + jittered backoff.
// Frame validation mirrors shared/protocol.mjs parseFrame: { v: 1, type: string }.
import { wsUrl } from "./util.mjs";

export class PushChannel {
  constructor() {
    this.listeners = new Map(); // frame type -> Set<fn>
    this.openListeners = new Set();
    this.downListeners = new Set();
    this.ws = null;
    this.attempt = 0;
    this.timer = null;
    this.stopped = false;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  onOpen(fn) {
    this.openListeners.add(fn);
    return () => this.openListeners.delete(fn);
  }

  onDown(fn) {
    this.downListeners.add(fn);
    return () => this.downListeners.delete(fn);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  // The socket is confirmed open. iOS restores background tabs with sockets
  // that died silently while suspended — callers force a redial when the tab
  // becomes visible and this is false.
  get open() {
    return !!this.ws && this.ws.readyState === 1;
  }

  forceReconnect() {
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = null;
    // A restored tab can hold a half-open socket that will never fire close —
    // drop any previous socket before dialing, so a reconnect attempt is real.
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      for (const fn of this.openListeners) {
        try {
          fn();
        } catch {}
      }
    };
    ws.onmessage = (e) => {
      let f;
      try {
        f = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;
      }
      if (!f || typeof f !== "object" || f.v !== 1 || typeof f.type !== "string") return;
      const set = this.listeners.get(f.type);
      if (set) for (const fn of set) {
        try {
          fn(f);
        } catch (err) {
          // A frame handler crashed — surface it on the page (field
          // diagnostics) instead of swallowing it silently.
          window.dispatchEvent(new ErrorEvent("error", { message: `frame handler failed (${f.type}): ${err?.message || err}` }));
        }
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      for (const fn of this.downListeners) {
        try {
          fn();
        } catch {}
      }
      this.scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  scheduleRetry() {
    if (this.stopped || this.timer) return;
    // 0.5 s doubling to a 30 s cap, with +/-25% jitter.
    const base = Math.min(30000, 500 * 2 ** Math.min(this.attempt, 6));
    const delay = base * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
