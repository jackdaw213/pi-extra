// Entry point: auth flow, hash routing, WS wiring. Browser only
// (boot() runs only when a DOM exists, so Node can import this safely).
import { initToastHost, toast } from "./ui.mjs";
import * as api from "./api.mjs";
import { PushChannel } from "./ws.mjs";
import { renderDashboard, onSpawnResult } from "./dashboard.mjs";
import { wireLoginButton, onPasskeyLoginSuccess, mountBanner } from "./passkeys.mjs";
import * as attach from "./attach.mjs";
import { parseHash } from "./util.mjs";
import { createIdleController } from "./idle.mjs";

const state = {
  reg: { machines: [] },
  authed: false,
  current: null, // { machineId, sessionId } while attached
};

let views = null;
let connDot = null;

function q(id) {
  return document.getElementById(id);
}

function show(name) {
  for (const k of Object.keys(views)) views[k].hidden = k !== name;
}

function setConn(up) {
  connDot.classList.toggle("open", up);
  connDot.classList.toggle("down", !up);
  connDot.title = up ? "Connected" : "Reconnecting…";
}

async function loadRegistry() {
  try {
    state.reg = await api.getRegistry();
    state.authed = true;
  } catch (e) {
    if (!/signed in/i.test(String(e.message))) toast(e.message, "error");
  }
}

function renderDash() {
  renderDashboard(q("machine-list"), state.reg, { refresh: refreshRegistry });
  mountBanner(q("passkey-banner"));
}

async function refreshRegistry() {
  await loadRegistry();
  if (!state.authed) {
    show("login");
    return;
  }
  if (state.current) attach.updateFromRegistry(state.reg);
  else if (!views.dashboard.hidden) renderDash();
}

function route() {
  const r = parseHash(location.hash);
  if (!state.authed) {
    show("login");
    void wireLoginButton(q("login-passkey"));
    return;
  }
  if (r) {
    state.current = r;
    attach.open(r.machineId, r.sessionId, state.reg);
    show("attach");
  } else {
    state.current = null;
    attach.close();
    renderDash();
    show("dashboard");
  }
}

function boot() {
  initToastHost();
  // Field diagnostics: surface any uncaught error ON the page (red banner)
  // so a broken render is visible in a screenshot instead of a silent
  // console nobody can open on a phone.
  const showPageError = (msg) => {
    let banner = document.getElementById("page-error");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "page-error";
      banner.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:9999;background:#3c2828;color:#ff9d97;font:12px/1.4 monospace;padding:6px 10px;max-height:40%;overflow:auto;white-space:pre-wrap;";
      document.body.append(banner);
    }
    banner.textContent += msg + "\n";
  };
  window.addEventListener("error", (e) => showPageError(`error: ${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => showPageError(`rejection: ${e.reason}`));
  views = {
    login: q("view-login"),
    dashboard: q("view-dashboard"),
    attach: q("view-attach"),
  };
  connDot = q("conn-dot");
  setConn(false);

  // Login view: POST /api/login; cookie carries auth from here on.
  q("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = q("login-error");
    const btn = q("login-submit");
    err.textContent = "";
    btn.disabled = true;
    try {
      await api.login(q("login-password").value);
      state.authed = true;
      await refreshRegistry();
      route();
    } catch (e2) {
      err.textContent = e2.message || "Login failed";
    } finally {
      btn.disabled = false;
    }
  });

  // Passkey login shares the password form's post-login path; errors are
  // reported by the passkey module into #login-error.
  onPasskeyLoginSuccess(async () => {
    state.authed = true;
    await refreshRegistry();
    route();
  });

  // Any API 401 -> back to the login view.
  api.setUnauthorizedHandler(() => {
    state.authed = false;
    if (!views.login.hidden) return;
    show("login");
    toast("Signed out. Sign in again.", "info");
  });

  // Idle sign-out: 15 quiet minutes on the hub ends the session. Using the
  // app — taps, keys, scrolling, any API call — resets the countdown, which
  // restarts only once nothing happens again. Gestures also ping the hub
  // (throttled to one per minute) so server-side sliding sessions track the
  // same activity.
  const IDLE_MS = 15 * 60_000;
  let lastPing = 0;
  const onActivity = () => {
    idle.activity();
    if (!state.authed) return;
    const now = Date.now();
    if (now - lastPing > 60_000) {
      lastPing = now;
      api.ping();
    }
  };
  const idle = createIdleController({
    idleMs: IDLE_MS,
    onExpire: () => {
      if (!state.authed) return;
      api.logout();
      state.authed = false;
      attach.close();
      show("login");
      toast("Signed out after 15 minutes idle.", "info");
    },
  });
  api.setActivityListener(onActivity);
  for (const type of ["pointerdown", "keydown", "scroll", "wheel", "visibilitychange"]) {
    document.addEventListener(type, onActivity, { passive: true, capture: true });
  }
  idle.start();

  const channel = new PushChannel();
  let firstOpen = true;

  channel.onOpen(async () => {
    setConn(true);
    await refreshRegistry(); // re-GET /api/registry on (re)connect
    if (!state.authed) {
      show("login");
      return;
    }
    if (firstOpen) {
      firstOpen = false;
      route();
    } else {
      toast("Back online");
    }
  });
  channel.onDown(() => setConn(false));

  // Full registry snapshot on change.
  channel.on("registry", (f) => {
    if (!state.authed) return;
    if (Array.isArray(f.machines)) state.reg = { machines: f.machines };
    if (state.current && !views.attach.hidden) attach.updateFromRegistry(state.reg);
    else if (!views.dashboard.hidden) renderDash();
  });

  // Raw pi events fan out to all phones; the attach view filters by sessionId
  // and buffers while a history replay load is in flight.
  channel.on("event", (f) => {
    if (state.current && f.sessionId === state.current.sessionId && !views.attach.hidden) {
      attach.handleLiveEvent(f.ev);
    }
  });

  // History replay chunks (reply to POST /api/history) for the attach view.
  channel.on("history", (f) => {
    if (state.current && f.sessionId === state.current.sessionId && !views.attach.hidden) {
      attach.handleHistoryChunk(f);
    }
  });

  // Ask-user question intercepted by the extension; the attach view renders
  // the question card and owns the answer (chip tap or typed custom text).
  channel.on("question", (f) => {
    if (state.current && f.sessionId === state.current.sessionId && !views.attach.hidden) {
      attach.handleQuestion(f);
    }
  });

  // Session -> phone file transfer.
  channel.on("file", (f) => {
    if (state.current && f.sessionId === state.current.sessionId && !views.attach.hidden) {
      attach.handleFile(f);
    }
  });

  // Outcome of POST /api/spawn.
  channel.on("spawn_result", (f) => onSpawnResult(f, refreshRegistry));

  // Outcome of POST /api/message (echo by ref; only errors surface here).
  channel.on("message_result", (f) => {
    if (state.current && f.sessionId === state.current.sessionId && f.ok === false) {
      toast(`Message failed${f.error ? `: ${f.error}` : ""}`, "error");
    }
  });

  window.addEventListener("hashchange", route);
  // iOS restores background tabs with sockets that died while suspended (no
  // close event ever fired). When the tab becomes visible again and the
  // channel is not open, redial immediately — onOpen re-fetches the registry
  // and the view wakes up instead of showing a frozen transcript.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !channel.open) {
      channel.forceReconnect();
      refreshRegistry();
    }
  });
  channel.start();
  refreshRegistry().then(route);
}

if (typeof document !== "undefined") {
  boot();
}
