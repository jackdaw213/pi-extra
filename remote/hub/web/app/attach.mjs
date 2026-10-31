// Attach view: live transcript for one session (WS "event" frames filtered by
// sessionId) + message box with steer/queue toggle, file attach, download
// cards, abort, and stop (remote sessions only).
//
// Also owns: session history replay (POST /api/history -> WS "history" chunk
// frames, buffered live frames join seamlessly below it), ask-user question
// cards (WS "question" frames; chips and composer both answer), and subagent
// nesting (tool events carrying parentToolCallId render inside their parent
// tool card, never in the main stream).
import { el, toast } from "./ui.mjs";
import * as api from "./api.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { pickImageFiles, filterAttachable } from "./clipboard.mjs";
import { isAskUserTool } from "./util.mjs";
import {
  createHistoryBuffer,
  acceptHistoryChunk,
  assembleHistoryEvents,
} from "./history-buffer.mjs";
import {
  argsSummary,
  fmtBytes,
  fmtMs,
  b64Bytes,
  assistantTextFrom,
  userTextFrom,
  userDisplayText,
  basename,
  isInputEcho,
} from "./util.mjs";
import { parseTodoTasks, renderTodoModel } from "./todo-view.mjs";
import { summarizeAgents, agentLabel } from "./agents-view.mjs";

const PENDING_MAX_TOTAL = 50 * 1024 * 1024; // matches the hub's message cap

// Tool cards are color coded like pi's own transcript: running = accent
// (pulsing), finished = quiet, errored = red.
function finishToolCard(card, isError) {
  card.classList.remove("tool-running");
  if (isError) card.classList.add("tool-error");
  else card.classList.add("tool-done");
  const dur = card.querySelector(".tool-dur");
  if (dur) dur.classList.remove("tool-dur-running");
}
const MD_THROTTLE_MS = 100; // markdown re-render cap while streaming
const HISTORY_TIMEOUT_MS = 4000; // no-history watchdog, armed once POST /api/history succeeds

const view = {
  machineId: null,
  sessionId: null,
  session: null, // latest sessionSummary from registry, or null if gone
  stick: true, // auto-scroll while transcript is near bottom
  stream: null, // current streaming assistant container
  streamBlocks: new Map(), // contentIndex -> { el, text, dirty }
  mdTimer: null, // pending throttled markdown re-render
  thinkingEl: null, // live "thinking…" indicator inside the streaming block
  tools: new Map(), // toolCallId -> { card, head, durEl, nest, badge, running, parent }
  pendingInput: null, // user text from `input` awaiting its message_start echo
  deliverAs: "steer", // "steer" | "followUp" — applies while the session is working
  hist: null, // history load in flight: { buf, buffer, done, timer }
  question: null, // pending ask-user question (see showQuestion), else null
  hintDismissed: false, // answer hint hidden visually only; the question stays answerable
  pending: [], // files waiting in the composer to ride with the next message
  todoTasks: null, // latest todo snapshot (parseTodoTasks output), null = none seen
  todoEls: null, // { count, body } rendered into #todo-panel
  agentsEls: null, // { count, body } rendered into #agents-panel
  els: {},
};

function q(id) {
  return document.getElementById(id);
}

function findSession(registry, machineId, sessionId) {
  for (const m of (registry && registry.machines) || []) {
    for (const s of m.sessions || []) {
      if (m.machine && m.machine.id === machineId && s.id === sessionId) {
        return { machine: m.machine, session: s };
      }
    }
  }
  return null;
}

function currentState() {
  return view.session ? view.session.state || "idle" : "offline";
}

// --- layout ----------------------------------------------------------------

export function open(machineId, sessionId, registry) {
  view.machineId = machineId;
  view.sessionId = sessionId;
  view.session = null;
  view.stick = true;
  view.stream = null;
  view.thinkingEl = null;
  view.streamBlocks = new Map();
  view.mdTimer = null;
  view.tools = new Map();
  view.pendingInput = null;
  view.deliverAs = "steer";
  if (view.hist) clearHistoryTimer(view.hist); // re-attach: stop the old watchdog
  view.hist = null;
  view.question = null;
  view.hintDismissed = false;
  view.todoTasks = null; // panels rebuild below, collapsed and hidden

  const transcript = q("transcript");
  transcript.replaceChildren();
  transcript.onscroll = () => {
    view.stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  };

  const input = q("composer-input");
  input.value = "";
  if (view.els.qHint) view.els.qHint.remove(); // re-attach: drop the old hint row
  const hintRow = el(
    "div",
    { class: "q-hint", hidden: true },
    el("span", { class: "q-hint-text" }),
    el(
      "button",
      {
        type: "button",
        class: "q-hint-x",
        "aria-label": "Dismiss hint",
        onclick: () => {
          view.hintDismissed = true; // visual only; the question stays answerable
          hintRow.hidden = true;
        },
      },
      "×"
    )
  );
  view.els = {
    name: q("attach-name"),
    sub: q("attach-sub"),
    abort: q("attach-abort"),
    stop: q("attach-stop"),
    back: q("attach-back"),
    transcript,
    form: q("composer"),
    input,
    qHint: hintRow,
    qHintText: hintRow.querySelector(".q-hint-text"),
    fileInput: q("file-input"),
    pendingRow: q("pending-row"),
    fileBtn: q("file-btn"),
    deliverasRow: q("deliveras-row"),
    segSteer: q("seg-steer"),
    segQueue: q("seg-queue"),
    todoPanel: q("todo-panel"),
    agentsPanel: q("agents-panel"),
    offlineNote: el("div", { class: "note", text: "Not connected — waiting for session…" }),
  };
  transcript.append(view.els.offlineNote);

  setupTodoPanel();
  setupAgentsPanel();

  view.els.back.onclick = () => {
    location.hash = "#/";
  };
  view.els.abort.onclick = async () => {
    try {
      await api.abortSession(view.sessionId, view.machineId);
      toast("Abort sent");
    } catch (e) {
      toast(e.message, "error");
    }
  };
  view.els.stop.onclick = async () => {
    if (!confirm("Stop this session? The agent exits.")) return;
    try {
      await api.stopSession(view.sessionId, view.machineId);
      toast("Stop sent");
    } catch (e) {
      toast(e.message, "error");
    }
  };
  view.els.fileBtn.onclick = () => view.els.fileInput.click();
  view.els.fileInput.onchange = onFilePicked;
  view.els.form.prepend(hintRow);
  view.els.segSteer.onclick = () => setSeg("steer");
  view.els.segQueue.onclick = () => setSeg("followUp");
  view.els.input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      view.els.form.requestSubmit();
    }
  };
  view.els.input.oninput = autogrow;
  view.els.input.addEventListener("paste", onPaste);
  view.els.form.onsubmit = onSend;

  setSeg("steer");
  clearPending(); // no attachments may leak across re-attach
  updateFromRegistry(registry);
  autogrow();
  startHistoryLoad();
}

export function close() {
  if (view.hist) clearHistoryTimer(view.hist); // stop the watchdog of a view being left
  view.machineId = null;
  view.sessionId = null;
  view.session = null;
  view.hist = null;
  view.question = null;
}

// Refresh header + controls from a registry snapshot (GET or WS "registry").
export function updateFromRegistry(registry) {
  if (!view.sessionId || !view.els.name) return;
  const found = findSession(registry, view.machineId, view.sessionId);
  view.session = found ? found.session : null;

  const state = currentState();
  // The session reads blocked exactly while the extension waits on a question;
  // leaving blocked means it settled the question itself (run resumed, or the
  // run was aborted). The phone never sends cancelled — it just stands down.
  if (state !== "blocked" && view.question) settleUnansweredQuestion();
  const s = found ? found.session : null;
  view.els.name.textContent = s ? s.name || view.sessionId : view.sessionId;
  view.els.sub.textContent = [
    found ? (found.machine.hostname || view.machineId) : view.machineId,
    s && s.cwd ? basename(s.cwd) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  view.els.offlineNote.hidden = !!found;
  view.els.stop.hidden = !s || s.mode !== "remote";
  view.els.deliverasRow.hidden = state !== "working";
}

// --- composer --------------------------------------------------------------

function setSeg(mode) {
  view.deliverAs = mode; // "steer" | "followUp" (SPEC deliverAs values)
  view.els.segSteer.classList.toggle("active", mode === "steer");
  view.els.segQueue.classList.toggle("active", mode === "followUp");
}

function autogrow() {
  const t = view.els.input;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
}

async function onSend(e) {
  e.preventDefault();
  const input = view.els.input;
  const text = input.value;
  if ((!text.trim() && view.pending.length === 0) || !view.sessionId) return;
  const q = view.question;
  if (q && !q.answered) {
    // Composer is in answer mode: typed text answers the pending question as
    // a custom response. Afterwards the composer returns to normal messaging.
    input.value = "";
    autogrow();
    try {
      await api.answer(view.machineId, view.sessionId, q.callId, { custom: text });
      settleQuestion(q, text);
    } catch (err) {
      toast(err.message, "error");
      input.value = text;
      autogrow();
    }
    return;
  }
  // Steer/queue only matters while working; idle turns ignore deliverAs.
  const deliverAs = currentState() === "working" ? view.deliverAs : undefined;
  // Pending attachments ride WITH this message: base64 them, send, clear.
  let attachments;
  if (view.pending.length > 0) {
    attachments = [];
    for (const p of view.pending) {
      const b64 = await fileToB64(p.file);
      attachments.push({ name: p.file.name || "attachment", mime: p.file.type || undefined, b64 });
    }
  }
  input.value = "";
  autogrow();
  try {
    await api.sendMessage(view.sessionId, view.machineId, text, deliverAs, attachments);
    clearPending();
  } catch (err) {
    toast(err.message, "error");
    input.value = text;
    autogrow();
  }
}

// FileReader -> base64 payload for H_MESSAGE attachments (browser only).
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error(`Could not read ${file.name || "attachment"}`));
    r.readAsDataURL(file);
  });
}

async function onFilePicked() {
  const input = view.els.fileInput;
  const files = Array.from(input.files || []);
  input.value = "";
  addPendingFiles(files);
}

function addPendingFiles(files) {
  if (!view.sessionId) return;
  const pendingBytes = view.pending.reduce((n, p) => n + (p.file.size || 0), 0);
  const { accepted, rejected } = filterAttachable(files, pendingBytes, PENDING_MAX_TOTAL);
  if (rejected.length > 0) toast("Attachment skipped — over the 50 MB total.", "error");
  for (const file of accepted) {
    view.pending.push({ file, url: file.type?.startsWith("image/") ? URL.createObjectURL(file) : null });
  }
  if (accepted.length > 0) renderPending();
}

function removePending(index) {
  const p = view.pending[index];
  if (p?.url) URL.revokeObjectURL(p.url);
  view.pending.splice(index, 1);
  renderPending();
}

function clearPending() {
  for (const p of view.pending) if (p.url) URL.revokeObjectURL(p.url);
  view.pending = [];
  renderPending();
}

function renderPending() {
  const row = view.els.pendingRow;
  if (!row) return;
  row.replaceChildren();
  row.hidden = view.pending.length === 0;
  view.pending.forEach((p, i) => {
    const chip = el("span", { class: "pending-chip" });
    if (p.url) chip.append(el("img", { class: "pending-thumb", src: p.url, alt: "" }));
    else chip.append(el("span", { class: "pending-icon", text: "📎" }));
    chip.append(el("span", { class: "pending-name", text: p.file.name || "attachment" }));
    chip.append(
      el("button", {
        class: "pending-x",
        type: "button",
        "aria-label": `Remove ${p.file.name || "attachment"}`,
        onclick: () => removePending(i),
      }, "×")
    );
    row.append(chip);
  });
}

// Paste a screenshot straight from the clipboard: image-only clipboards are
// intercepted and uploaded; text (or mixed text+image) pastes normally so
// normal typing and copied text are never disturbed.
function onPaste(e) {
  const files = pickImageFiles(e.clipboardData?.items);
  if (files.length === 0) return;
  if (typeof e.clipboardData.getData === "function" && e.clipboardData.getData("text/plain")) return;
  e.preventDefault();
  addPendingFiles(files);
}

// --- streaming markdown ----------------------------------------------------

// Re-render at most one block per MD_THROTTLE_MS while deltas arrive.
function scheduleMdRender(block) {
  block.dirty = true;
  if (view.mdTimer != null) return;
  view.mdTimer = setTimeout(() => {
    view.mdTimer = null;
    if (!view.stream) return;
    for (const b of view.streamBlocks.values()) {
      if (b.dirty) {
        b.dirty = false;
        renderBlockHtml(b.el, b.text);
      }
    }
  }, MD_THROTTLE_MS);
}

function flushMdTimer() {
  if (view.mdTimer != null) {
    clearTimeout(view.mdTimer);
    view.mdTimer = null;
  }
}

// A throw here aborts the whole frame handler and leaves stale stream state
// (thinkingEl, view.stream) behind; fall back to plain text instead.
function renderBlockHtml(node, text) {
  try {
    node.innerHTML = renderMarkdown(text);
  } catch {
    node.textContent = text;
  }
}

// Client-side mermaid: replace <pre><code class="language-mermaid"> with the
// rendered SVG. Browser-only, dynamically imported so Node can import this
// module. On load or parse failure the escaped source block stays visible.
let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("../vendor/mermaid/mermaid.esm.min.mjs").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
      });
      return mod.default;
    });
    mermaidPromise.catch(() => {
      mermaidPromise = null; // allow a retry on the next message
    });
  }
  return mermaidPromise;
}

async function renderMermaidIn(root) {
  const codes = root.querySelectorAll("pre > code.language-mermaid");
  if (!codes.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return; // mermaid unavailable: keep the escaped source
  }
  for (const code of codes) {
    if (!code.isConnected) continue;
    const pre = code.closest("pre");
    const id = `mmd-${Math.random().toString(36).slice(2)}`;
    try {
      const { svg } = await mermaid.render(id, code.textContent);
      if (!pre.isConnected) continue;
      const figure = document.createElement("div");
      figure.className = "mermaid-figure";
      figure.innerHTML = svg; // mermaid output under securityLevel "strict"
      pre.replaceWith(figure);
    } catch {
      // Parse failure: leave the escaped source visible (spec fallback).
      const bomb = document.getElementById(`d${id}`); // mermaid error artifact
      if (bomb) bomb.remove();
    }
  }
}

// --- transcript ------------------------------------------------------------

function append(node) {
  if (!view.els.transcript) return; // no view open yet
  view.els.transcript.append(node);
  if (view.stick) view.els.transcript.scrollTop = view.els.transcript.scrollHeight;
}

function addUser(text) {
  view.pendingInput = null;
  // Attachment plumbing lines are noise in the bubble; a send that carried
  // only attachments strips to nothing and gets a placeholder.
  const shown = userDisplayText(text) || "📎";
  append(el("div", { class: "msg user" }, el("div", { class: "msg-text", text: shown })));
}

function startStream() {
  view.pendingInput = null;
  view.thinkingEl = null; // a new stream never opens thinking: drop any stale row
  const wrap = el("div", { class: "msg assistant streaming" });
  append(wrap);
  view.stream = wrap;
  view.streamBlocks = new Map();
}

// "thinking · · ·" while the model reasons (thinking_* events) — the user
// sees nothing between tool cards and the first text otherwise.
function showThinking() {
  if (!view.stream) startStream();
  if (view.thinkingEl) {
    // A cached row can be stale (frame handler aborted mid-render, or detached
    // by endStream's replaceChildren); it must not silence the indicator forever.
    if (!view.thinkingEl.isConnected) view.thinkingEl = null;
    else return;
  }
  view.thinkingEl = el(
    "div",
    { class: "thinking-row", "aria-label": "Model is thinking" },
    el("span", { class: "thinking-label", text: "thinking" }),
    el("span", { class: "thinking-dots", "aria-hidden": "true" }, el("i"), el("i"), el("i"))
  );
  view.stream.append(view.thinkingEl);
  if (view.stick) view.els.transcript.scrollTop = view.els.transcript.scrollHeight;
}

function clearThinking() {
  if (view.thinkingEl) {
    view.thinkingEl.remove();
    view.thinkingEl = null;
  }
}

function ensureBlock(contentIndex) {
  if (!view.stream) startStream();
  const key = contentIndex == null ? "x" : contentIndex;
  if (!view.streamBlocks.has(key)) {
    const span = el("div", { class: "msg-text md" });
    view.stream.append(span);
    view.streamBlocks.set(key, { el: span, text: "", dirty: false });
  }
  return view.streamBlocks.get(key);
}

function appendDelta(contentIndex, delta) {
  const block = ensureBlock(contentIndex);
  block.text += delta;
  scheduleMdRender(block);
  if (view.stick) view.els.transcript.scrollTop = view.els.transcript.scrollHeight;
}

function endStream(message) {
  flushMdTimer();
  clearThinking();
  const text = assistantTextFrom(message);
  if (view.stream) {
    view.stream.classList.remove("streaming");
    if (text == null) view.stream.remove();
    else {
      const body = el("div", { class: "msg-text md" });
      renderBlockHtml(body, text); // final render of the full text
      view.stream.replaceChildren(body);
      renderMermaidIn(body);
    }
    view.stream = null;
    view.streamBlocks = new Map();
  } else if (text != null) {
    const body = el("div", { class: "msg-text md" });
    renderBlockHtml(body, text);
    append(el("div", { class: "msg assistant" }, body));
    renderMermaidIn(body);
  }
  if (view.stick) view.els.transcript.scrollTop = view.els.transcript.scrollHeight;
}

// --- tool cards + subagent nesting -----------------------------------------

// Live nested pi tool calls carry parentToolCallId and render inside the
// parent card's nested container, never in the main stream. A parent with no
// matching start (joined mid-run) leaves the child top level: fail-safe.
function makeToolEntry(ev) {
  const durEl = el("span", { class: "tool-dur tool-dur-running", text: "running" });
  const card = el(
    "div",
    { class: "tool-card tool-running" },
    el("div", { class: "tool-head" }, el("span", { class: "tool-name", text: ev.toolName || "tool" }), durEl),
    ev.args != null ? el("div", { class: "tool-args", text: argsSummary(ev.args) }) : null
  );
  if (ev.toolName === "agent") card.classList.add("tool-agent"); // subtle subagent styling
  return {
    card,
    head: card.querySelector(".tool-head"),
    durEl,
    nest: null,
    badge: null,
    running: 0,
    parent: null,
    toolName: ev.toolName || "tool", // panel input shape: { toolName, running, parent, label? }
    label: ev.toolName === "agent" ? agentLabel(ev.args) : null, // subagent type / task description
  };
}

// Upgrade a card into a collapsible parent on its first nested child: tappable
// header (default collapsed), running-count badge, nested container.
function ensureNested(entry) {
  if (!entry.nest) {
    entry.nest = el("div", { class: "tool-nested" });
    entry.card.append(entry.nest);
    entry.chevron = el("span", { class: "tool-chevron", "aria-hidden": "true", text: "▸" });
    entry.badge = el("span", { class: "tool-run", hidden: true, text: "0 running" });
    entry.head.insertBefore(entry.chevron, entry.head.firstChild);
    entry.head.insertBefore(entry.badge, entry.durEl);
    entry.card.classList.add("collapsible");
    entry.head.classList.add("tool-head-toggle");
    entry.head.onclick = () => entry.card.classList.toggle("open");
  }
  return entry.nest;
}

// Collapsed agent cards must stay legible: while children run, "N running"
// (accent); after they finish, "N calls" + chevron — otherwise a collapsed
// card looks like a bare line and the nested activity is invisible.
function updateRunBadge(entry) {
  if (!entry.badge) return;
  if (entry.running > 0) {
    entry.badge.hidden = false;
    entry.badge.textContent = `${entry.running} running`;
    entry.badge.classList.add("accent");
    return;
  }
  const total = entry.total || 0;
  if (total > 0) {
    entry.badge.hidden = false;
    entry.badge.textContent = `${total} call${total === 1 ? "" : "s"}`;
    entry.badge.classList.remove("accent");
  } else {
    entry.badge.hidden = true;
  }
}

function addTool(ev) {
  // Ask-user calls are represented by their question card (ADR 0008), never
  // by a tool card — the raw card would duplicate it. A silent entry keeps
  // the end/backstop logic consistent; if no question card ever appears
  // (multi-question call, bridge down), endTool renders a plain completed
  // card so the call is not invisible. The question frame normally arrives
  // BEFORE this event, but both orders are handled.
  if (isAskUserTool(ev.toolName)) {
    view.tools.set(ev.toolCallId, {
      card: null,
      head: null,
      durEl: null,
      nest: null,
      badge: null,
      running: 0,
      parent: null,
      toolName: ev.toolName,
      suppressed: true,
      hasQuestionCard: view.question?.callId === ev.toolCallId,
    });
    return;
  }
  const entry = makeToolEntry(ev);
  const parentId = typeof ev.parentToolCallId === "string" ? ev.parentToolCallId : null;
  const parent = parentId ? view.tools.get(parentId) : null;
  if (parent) {
    ensureNested(parent).append(entry.card);
    parent.running += 1;
    parent.total = (parent.total || 0) + 1;
    updateRunBadge(parent);
    entry.parent = parentId;
    if (view.stick) view.els.transcript.scrollTop = view.els.transcript.scrollHeight;
  } else {
    append(entry.card); // orphan (parent never seen): ordinary top-level card
  }
  if (ev.toolCallId) view.tools.set(ev.toolCallId, entry);
  renderAgentsPanel(); // a top-level agent start adds a running-subagents line
}

function endTool(ev) {
  // Ask-user (ADR 0008) fallback settle: blocked/declined calls (the non-TUI
  // interception) produce no tool_result event at all, so the end event is the
  // last word — stand the card down as "cancelled". Executed calls settle from
  // tool_result BEFORE pi emits this event, so an answered card is never
  // shown as cancelled here.
  const openQ = view.question;
  if (openQ && !openQ.answered && ev.toolCallId === openQ.callId) settleUnansweredQuestion();
  const durText = typeof ev.durationMs === "number" ? fmtMs(ev.durationMs) : "";
  const tracked = ev.toolCallId ? view.tools.get(ev.toolCallId) : null;
  if (tracked?.suppressed) {
    // The question card is the call's representation. Only when none ever
    // appeared does a plain completed card get rendered as a backstop.
    view.tools.delete(ev.toolCallId);
    if (!tracked.hasQuestionCard) append(plainToolCard(ev, durText));
    renderAgentsPanel();
    return;
  }
  if (tracked) {
    tracked.durEl.textContent = durText || "done";
    finishToolCard(tracked.card, ev.isError);
    view.tools.delete(ev.toolCallId);
    if (tracked.parent) {
      const parent = view.tools.get(tracked.parent);
      if (parent && parent.running > 0) {
        parent.running -= 1;
        updateRunBadge(parent);
      }
    }
    renderAgentsPanel(); // the ended call may have been a running-subagents line
    return;
  }
  // Missed the start frame (e.g. joined mid-run): render a complete card,
  // nested under the parent when it is known. An ask-user call whose question
  // card is on screen needs no duplicate — the card is its representation.
  if (isAskUserTool(ev.toolName) && view.question?.callId === ev.toolCallId) return;
  const card = plainToolCard(ev, durText);
  const parentId = typeof ev.parentToolCallId === "string" ? ev.parentToolCallId : null;
  const parent = parentId ? view.tools.get(parentId) : null;
  if (parent) ensureNested(parent).append(card);
  else append(card);
}

// A minimal finished tool card — missed-start calls, and the backstop for
// suppressed ask calls whose question card never appeared.
function plainToolCard(ev, durText) {
  const card = el(
    "div",
    { class: "tool-card" },
    el(
      "div",
      { class: "tool-head" },
      el("span", { class: "tool-name", text: ev.toolName || "tool" }),
      el("span", { class: "tool-dur", text: durText || "done" })
    )
  );
  finishToolCard(card, ev.isError);
  return card;
}

// --- panels above the composer (todos, running subagents) ------------------

// Static containers in index.html, filled here. Both collapse to their header
// row (tappable, chevron); collapsed by default, and hidden entirely while
// empty. Normal flow between the transcript and the composer — never fixed,
// never scroll-intercepting.
function buildSidePanel(panel, title) {
  panel.replaceChildren();
  panel.classList.remove("open");
  panel.hidden = true;
  const count = el("span", { class: "panel-count" });
  const head = el(
    "div",
    { class: "panel-head", role: "button", "aria-expanded": "false" },
    el("span", { class: "panel-title", text: title }),
    count
  );
  const body = el("div", { class: "panel-body" });
  head.onclick = () => {
    const open = panel.classList.toggle("open");
    head.setAttribute("aria-expanded", String(open));
  };
  panel.append(head, body);
  return { count, body };
}

function setupTodoPanel() {
  view.todoEls = buildSidePanel(view.els.todoPanel, "Todos");
  renderTodoPanel();
}

function setupAgentsPanel() {
  view.agentsEls = buildSidePanel(view.els.agentsPanel, "Subagents");
  renderAgentsPanel();
}

const TODO_ICONS = { todo: "□", doing: "◐", done: "✓" };

// Rebuild the todo panel from the latest parsed snapshot. Hidden until tasks
// exist; the collapse state survives refreshes.
function renderTodoPanel() {
  const panel = view.els.todoPanel;
  const els = view.todoEls;
  if (!panel || !els) return;
  const model = renderTodoModel(view.todoTasks || []);
  panel.hidden = model.total === 0; // empty list -> panel hidden entirely
  if (panel.hidden) return;
  els.count.textContent = `${model.done}/${model.total} done`;
  els.body.replaceChildren(
    ...model.lines.map((line) =>
      el(
        "div",
        { class: `todo-line ${line.icon}` },
        el("span", { class: "todo-icon", text: TODO_ICONS[line.icon] || "□" }),
        el("span", { class: "todo-subject", text: line.subject }),
        line.activeForm ? el("span", { class: "todo-active", text: line.activeForm }) : null
      )
    )
  );
}

// Rebuild the subagents panel from the live tool entries. Hidden entirely at
// zero running; the count is accented while subagents run.
function renderAgentsPanel() {
  const panel = view.els.agentsPanel;
  const els = view.agentsEls;
  if (!panel || !els) return;
  const model = summarizeAgents(view.tools.values());
  panel.hidden = model.running === 0;
  if (panel.hidden) return;
  els.count.textContent = `${model.running} running`;
  els.count.classList.add("accent");
  els.body.replaceChildren(
    ...model.lines.map((line) =>
      el(
        "div",
        { class: "agent-line" },
        el("span", { class: "agent-dot", "aria-hidden": "true" }),
        el("span", { class: "agent-label", text: line.label })
      )
    )
  );
}

// Download card for a WS "file" frame; tap -> GET /api/file?... (attachment).
export function handleFile(f) {
  if (!view.sessionId || f.sessionId !== view.sessionId) return;
  const name = f.name || "file";
  const size = typeof f.b64 === "string" ? fmtBytes(b64Bytes(f.b64)) : "";
  append(
    el(
      "div",
      { class: "filecard-row" },
      el(
        "a",
        {
          class: "filecard",
          href: api.fileDownloadUrl(view.machineId, view.sessionId, name),
          download: name,
        },
        el("span", { class: "filecard-icon", text: "↓" }),
        el("span", { class: "filecard-name", text: name }),
        size ? el("span", { class: "filecard-size", text: size }) : null
      )
    )
  );
}

// --- history replay --------------------------------------------------------

// Attach shows the session's entire past transcript: open() POSTs
// /api/history; the reply arrives as WS "history" chunk frames
// { sessionId, chunkIndex, chunkTotal, events }. While a load is in flight,
// live frames for the session buffer; on completion the replay renders
// oldest-first through the same handlers as live events, then the buffered
// frames flush below it — no duplication, no gaps. Re-attaching resets
// everything and re-requests; one load in flight at a time.
function startHistoryLoad() {
  const h = { buf: createHistoryBuffer(), buffer: [], done: false, timer: null };
  view.hist = h;
  api.historyRequest(view.machineId, view.sessionId).then(() => {
    // The POST routed: arm the no-history watchdog. An extension predating
    // history support never answers, so waiting forever would leave the view
    // silently empty; on timeout the load is cancelled, the buffered live
    // events flush, and a dim note explains the missing history.
    if (view.hist === h && !h.done) {
      h.timer = setTimeout(() => {
        h.timer = null;
        if (view.hist === h && !h.done) timeoutHistory();
      }, HISTORY_TIMEOUT_MS);
    }
  }).catch((e) => {
    // The request never routed (offline, session gone): stand down and keep
    // live output flowing from the buffer.
    if (view.hist === h && !h.done) failHistory(e.message);
  });
}

// Live raw pi event, routed here from main.mjs; buffered while history loads.
export function handleLiveEvent(ev) {
  if (!view.sessionId) return;
  if (view.hist) {
    view.hist.buffer.push({ kind: "event", ev });
    return;
  }
  handleEvent(ev);
}

// One WS "history" frame. chunkTotal 0 = the session has no history.
export function handleHistoryChunk(f) {
  if (!view.sessionId || !view.hist) return; // no load in flight: straggler
  if (acceptHistoryChunk(view.hist.buf, f)) finishHistory();
}

function finishHistory() {
  const h = view.hist;
  if (!h || h.done) return;
  h.done = true;
  clearHistoryTimer(h);
  view.hist = null; // from here on, live frames render as they arrive
  // Chunk order is stream order: oldest first. Replay events are exactly the
  // live pi event shapes handleEvent renders (markdown applies unchanged);
  // replay carries no parentToolCallId, so tool cards render top level.
  const events = assembleHistoryEvents(h.buf) ?? [];
  for (const ev of events) handleEvent(ev);
  flushBuffered(h.buffer);
}

function failHistory(message) {
  const h = view.hist;
  if (!h || h.done) return;
  h.done = true;
  clearHistoryTimer(h);
  view.hist = null;
  toast(`History unavailable: ${message}`, "error");
  flushBuffered(h.buffer);
}

// Watchdog fired: the POST routed but no complete chunk set arrived within
// HISTORY_TIMEOUT_MS — the session's extension predates history support, or
// stalled mid-replay. Cancel the load; late "history" frames are dropped by
// the same straggler guard that ignores frames with no load in flight (see
// handleHistoryChunk). Show the dim note at the top of the transcript and
// flush buffered live events so the view goes live.
function timeoutHistory() {
  const h = view.hist;
  if (!h || h.done) return;
  h.done = true;
  clearHistoryTimer(h);
  view.hist = null;
  showHistoryNote();
  flushBuffered(h.buffer);
}

function clearHistoryTimer(h) {
  if (h && h.timer != null) {
    clearTimeout(h.timer);
    h.timer = null;
  }
}

function showHistoryNote() {
  const t = view.els.transcript;
  if (!t) return;
  t.prepend(
    el(
      "div",
      { class: "note", text: "No history from this session — its pi-remote extension may be out of date." }
    )
  );
}

function flushBuffered(frames) {
  for (const f of frames) {
    if (f.kind === "question") showQuestion(f.q);
    else handleEvent(f.ev);
  }
}

// --- question cards --------------------------------------------------------

// A WS "question" frame: the extension mapped an ask-user tool call (rpiv's
// ask_user_question, ADR 0008) onto the phone contract. callId is pi's real
// toolCallId; the same id comes back on forwarded tool_result and
// tool_execution_end events when the terminal answers first.
function normalizeQuestion(f) {
  if (!f || typeof f.callId !== "string" || !f.callId) return null;
  if (typeof f.question !== "string" || !f.question) return null;
  return {
    callId: f.callId,
    toolName: typeof f.toolName === "string" && f.toolName ? f.toolName : "ask_user_question",
    question: f.question,
    options: Array.isArray(f.options)
      ? f.options.filter((o) => typeof o === "string" && o.length > 0)
      : [],
    multiSelect: f.multiSelect === true,
    answered: false,
    card: null,
    chipsEl: null,
  };
}

export function handleQuestion(f) {
  if (!view.sessionId) return;
  const q = normalizeQuestion(f);
  if (!q) return;
  if (view.hist) {
    view.hist.buffer.push({ kind: "question", q }); // renders at the true end, after replay
    return;
  }
  showQuestion(q);
}

function showQuestion(q) {
  // Last-known question only: a new A_QUESTION replaces the pending one.
  if (view.question && view.question.card) view.question.card.remove();
  view.question = q;
  view.hintDismissed = false;
  updateHint();

  const qText = el("div", { class: "q-text md" });
  qText.innerHTML = renderMarkdown(q.question); // sanitized renderer, like replies

  const chips = el("div", { class: "q-chips" });
  if (q.multiSelect) {
    const selected = new Set();
    const commit = el(
      "button",
      {
        type: "button",
        class: "chip chip-commit",
        disabled: true,
        onclick: () => answerQuestion(q, [...selected].join(", ")),
      },
      "Send answers"
    );
    for (const opt of q.options) {
      chips.append(
        el(
          "button",
          {
            type: "button",
            class: "chip",
            onclick: (e) => {
              if (selected.has(opt)) selected.delete(opt);
              else selected.add(opt);
              e.currentTarget.classList.toggle("selected", selected.has(opt));
              commit.disabled = selected.size === 0;
            },
          },
          opt
        )
      );
    }
    chips.append(commit);
  } else {
    for (const opt of q.options) {
      chips.append(
        el("button", { type: "button", class: "chip", onclick: () => answerQuestion(q, opt) }, opt)
      );
    }
  }

  q.card = el(
    "div",
    { class: "question-card" },
    // pi-style header: bold "Ask" label + the question as the title line
    el("div", { class: "q-head" }, el("span", { class: "q-tool", text: askLabel(q.toolName), title: q.toolName })),
    qText,
    chips
  );
  q.chipsEl = chips;
  append(q.card);
}

// pi renders ask-user calls under the label "Ask"; match it, keeping the raw
// tool name in the tooltip.
function askLabel(toolName) {
  return /ask_user_question$/.test(toolName || "") ? "Ask" : toolName || "Ask";
}

const ASK_TOOL_RE = /^([a-z_]*_)?ask_user_question$/;

// Mirrors shared/question.mjs phoneSettleFromToolResult (the hub serves only
// ./web, so the browser cannot import shared/ directly — keep in sync): what a
// forwarded ask-user tool_result event shows on the card. details is rpiv's
// QuestionnaireResult { answers, cancelled }; errored or declined calls settle
// as cancelled. Returns { text } | { cancelled: true } | null (not an ask tool).
function askSettleFromToolResult(ev) {
  if (!ev || typeof ev.toolName !== "string" || !ASK_TOOL_RE.test(ev.toolName)) return null;
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

async function answerQuestion(q, value) {
  if (q.answered) return;
  try {
    await api.answer(view.machineId, view.sessionId, q.callId, { value });
    settleQuestion(q, value);
  } catch (e) {
    toast(e.message, "error"); // chips stay enabled: still answerable
  }
}

// The question got its answer: collapse the card to the answered state
// showing the chosen value, and return the composer to normal messaging.
function settleQuestion(q, shown) {
  q.answered = true;
  closeQuestionCard(q, shown, false);
  if (view.question === q) {
    view.question = null;
    updateHint();
  }
}

// The extension settled the question without a phone answer (run resumed
// elsewhere or was aborted): stand down, disable the card.
function settleUnansweredQuestion() {
  const q = view.question;
  if (!q || q.answered) return;
  q.answered = true;
  closeQuestionCard(q, "settled", true);
  if (view.question === q) {
    view.question = null;
    updateHint();
  }
}

function closeQuestionCard(q, shown, dim) {
  if (!q.card) return;
  q.card.classList.add(dim ? "settled" : "answered");
  // pi-style result line: mono, marker prefix — ✓ answered, × cancelled.
  const row = el(
    "div",
    { class: dim ? "q-answer q-answer-settled" : "q-answer" },
    el("span", { class: dim ? "q-mark q-mark-x" : "q-mark q-mark-check", text: dim ? "×" : "✓" }),
    el("span", { class: "q-answer-value", text: dim ? "cancelled" : shown })
  );
  if (q.chipsEl) q.chipsEl.replaceWith(row);
  else q.card.append(row);
  q.chipsEl = null;
}

// Composer answer-mode hint: shown while a question is pending, unless the
// user dismissed it visually — the question stays answerable regardless.
function updateHint() {
  const h = view.els.qHint;
  if (!h) return;
  const show = !!(view.question && !view.hintDismissed);
  h.hidden = !show;
  if (show) {
    view.els.qHintText.textContent = `Answering ${view.question.toolName} — type your answer`;
  }
}

// Handle one raw pi event (frame ev) for the attached session.
export function handleEvent(ev) {
  if (!ev || typeof ev.type !== "string") return;
  switch (ev.type) {
    case "input": {
      const t = userTextFrom(ev);
      if (t != null) {
        addUser(t);
        view.pendingInput = t; // expect a user message_start echo next
      }
      break;
    }
    case "message_start": {
      const m = ev.message;
      if (m && m.role === "user") {
        const t = userTextFrom(ev);
        if (t != null) {
          // The echo of the phone's own send may carry extra display lines
          // (one per image attachment) after the sent text — prefix match.
          if (isInputEcho(view.pendingInput, t)) view.pendingInput = null;
          else addUser(t);
        }
      } else if (m && m.role === "assistant") {
        startStream();
      }
      break;
    }
    case "message_update": {
      const a = ev.assistantMessageEvent;
      if (!a) break;
      if (a.type === "text_delta" && typeof a.delta === "string") {
        clearThinking();
        appendDelta(a.contentIndex, a.delta);
      } else if (a.type === "text_start") {
        clearThinking();
        ensureBlock(a.contentIndex);
      } else if (a.type === "thinking_start" || a.type === "thinking_delta") {
        showThinking();
      } else if (a.type === "thinking_end") {
        clearThinking();
      } else if (a.type === "text_end" && typeof a.content === "string") {
        // Authoritative full text of this block: render it now, unthrottled.
        clearThinking();
        const block = ensureBlock(a.contentIndex);
        block.text = a.content;
        flushMdTimer();
        renderBlockHtml(block.el, block.text);
        block.dirty = false;
      }
      break;
    }
    case "message_end": {
      const m = ev.message;
      if (m && m.role === "assistant") endStream(m);
      break;
    }
    case "tool_execution_start":
      addTool(ev);
      break;
    case "tool_execution_end":
      endTool(ev);
      break;
    case "tool_result": {
      // The todo tool (rpiv-todo) returns the full state snapshot under the
      // result's details on every successful call; keep the latest one and
      // refresh the panel. Other tools' results (and errored calls) are ignored.
      if (ev.toolName === "todo" && ev.isError !== true) {
        const tasks = parseTodoTasks(ev);
        if (tasks !== null) {
          view.todoTasks = tasks;
          renderTodoPanel();
        }
      }
      // Ask-user (ADR 0008): the TERMINAL answered (or declined) — settle the
      // matching question card with the recorded answer, or "cancelled" for a
      // declined/errored result. A card the phone answered itself is already
      // settled and untouched (view.question is null).
      const q = view.question;
      if (q && !q.answered && ev.toolCallId === q.callId) {
        const s = askSettleFromToolResult(ev);
        if (s && s.cancelled === true) settleUnansweredQuestion();
        else if (s) settleQuestion(q, s.text || "answered");
      }
      break;
    }
    case "agent_settled":
      append(el("div", { class: "divider", text: "— done —" }));
      break;
    default:
      break; // agent_start/end, turn_*, queue_update, compaction_*, … ignored
  }
}
