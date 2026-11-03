// Dashboard: machines as sections, session cards, one floating spawn button.
// Data comes from GET /api/registry and WS "registry" snapshots (same shape).
// Session cards support right-to-left swipe revealing Delete (ADR 0006):
// deleting a temp session also erases its transcript, a normal or terminal
// session is only stopped. Dragging a card past the full-swipe threshold (or
// a fast leftward flick) deletes at once, no button tap needed.
// Spawn is one floating "+" button: tap = temp session (default), press-and-
// hold >= 600 ms = normal session (the keeper).
import { el, toast, badge } from "./ui.mjs";
import { basename, attachRoute } from "./util.mjs";
import * as api from "./api.mjs";
import { createSwipeMachine, REVEAL_WIDTH_PX } from "./swipe.mjs";

// refs of spawns we requested, so spawn_result frames can be matched.
const pendingSpawns = new Set();

// Refresh hook, wired from main.mjs so a delete can re-pull the registry.
let refreshHook = null;

// Cards whose swipe is currently open; opening one closes the others.
const openRows = new Set();

// FAB press-and-hold duration for the normal-session (keeper) spawn.
const FAB_HOLD_MS = 600;

// "New session" -> POST /api/spawn (kind "temp" by default, "normal" for the
// keeper option) -> toast "Starting…". Outcome arrives as WS spawn_result.
export async function requestSpawn(machineId, kind = "temp") {
  toast("Starting…");
  try {
    const ref = await api.spawnSession(machineId, undefined, kind);
    if (ref) pendingSpawns.add(ref);
  } catch (e) {
    toast(e.message, "error");
  }
}

// WS spawn_result: ok -> "Session started" + refresh registry; error -> show it.
export function onSpawnResult(f, refresh) {
  let ours = false;
  if (f.ref) ours = pendingSpawns.delete(f.ref);
  else if (pendingSpawns.size > 0) {
    pendingSpawns.clear();
    ours = true;
  }
  if (!ours) return;
  if (f.ok) {
    toast("Session started");
    if (refresh) refresh();
  } else {
    toast(f.error ? `Spawn failed: ${f.error}` : "Spawn failed", "error");
  }
}

// Applies a swipe machine state to the card. The Delete button sits behind
// the card, on its right; translating the card left reveals it.
function applySwipe(row, card, st) {
  if (st.reveal === "open") {
    card.style.transition = "";
    card.style.transform = `translateX(${-REVEAL_WIDTH_PX}px)`;
    row.classList.add("swipe-open");
    openRows.add(row);
  } else if (st.reveal === "opening") {
    card.style.transition = "none";
    card.style.transform = `translateX(${st.px}px)`;
    row.classList.remove("swipe-open");
  } else {
    card.style.transition = "";
    card.style.transform = "";
    row.classList.remove("swipe-open");
    openRows.delete(row);
  }
}

function closeRow(row) {
  const card = row.querySelector(".swipe-card");
  if (card) {
    card.style.transition = "";
    card.style.transform = "";
  }
  row.classList.remove("swipe-open");
  openRows.delete(row);
}

// Immediate visible feedback for ANY delete trigger (button tap or full
// swipe): card dims, toast flies, card animates out optimistically. The next
// registry snapshot reconciles — if the session reappears (stale extension,
// failed delete), it stays; we never fight the registry.
// The reconciliation re-pull is delayed ~1.5 s: an immediate GET races the
// extension teardown (the session is still registered until its socket
// closes) and pops the card right back for a blink. The WS registry frame
// that lands when the hub drops the session re-renders earlier anyway; this
// delayed GET is the fallback for a phone whose push socket is suspended.
const DELETE_RECONCILE_MS = 1500;

function beginDelete(machineId, s, row) {
  toast("Delete sent");
  row.classList.add("card-leaving");
  openRows.delete(row);
  const erase = s.kind === "temp";
  api.deleteSession(machineId, s.id, erase)
    .catch((e) => toast(e.message, "error"));
  row.classList.add("card-exit");
  const remove = () => row.remove();
  row.addEventListener("animationend", remove, { once: true });
  setTimeout(remove, 500); // fallback if animationend never fires
  if (refreshHook) setTimeout(refreshHook, DELETE_RECONCILE_MS);
}

// Pointer events (touch + mouse) drive the pure state machine; the card
// captures its pointer so moves outside the card still track. touch-action
// pan-y keeps vertical scrolling with the browser: a vertical-dominant drag
// locks to axis y, the machine disengages, and the browser's pointercancel
// (when it starts scrolling) resets everything. Clicks after a real drag or
// while the row is open are swallowed so they never navigate.
function wireSwipe(row, card, onTap, onDelete) {
  const machine = createSwipeMachine();
  let pointerId = null;
  let moved = false; // pointer left the tap slop this gesture
  let swallowClick = false; // the click following a handled pointer

  card.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    moved = false;
    swallowClick = false;
    try {
      card.setPointerCapture?.(pointerId);
    } catch {}
    for (const other of [...openRows]) {
      if (other !== row) closeRow(other);
    }
    const offset = row.classList.contains("swipe-open") ? -REVEAL_WIDTH_PX : 0;
    machine.update({
      phase: "start",
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
      offset,
    });
  });

  card.addEventListener("pointermove", (e) => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const st = machine.update({
      phase: "move",
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
    });
    if (st.axis === "x") {
      moved = true;
      openRows.add(row);
    }
    if (st.axis === "y") return; // scrolling owns this gesture; apply nothing
    applySwipe(row, card, st);
  });

  const finish = (e) => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    pointerId = null;
    swallowClick = true;
    const st = machine.update({
      phase: e.type === "pointercancel" ? "cancel" : "end",
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
    });
    if (st.action === "delete") {
      row.querySelector(".swipe-card")?.style.removeProperty("transition");
      onDelete();
      return;
    }
    applySwipe(row, card, st);
    if (st.tap) {
      // wasOpen must be captured BEFORE applySwipe: a tap maps to reveal
      // "closed", which already removes the class. Capturing after the call
      // made tap-to-close a dead branch and every tap navigated instead.
      const wasOpen = row.classList.contains("swipe-open");
      if (wasOpen) closeRow(row); // tap closes
      else onTap();
    }
  };
  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);

  // Suppress the click that follows a handled pointer (drag or tap): mouse
  // and touch navigation goes through the tap path above, never twice.
  card.addEventListener(
    "click",
    (e) => {
      if (moved || swallowClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

function sessionCard(machineId, s) {
  const state = s.state || "idle";
  const mode = s.mode || "terminal";
  const card = el(
    "button",
    {
      class: "card session-card",
      type: "button",
      "aria-label": `Open session ${s.name || s.id}`,
      // Keyboard/AT activation path. Pointer taps navigate through the swipe
      // tap handler instead; the capture-phase click guard on the swipe card
      // stops this from double-firing after a handled pointer.
      onclick: () => {
        location.hash = attachRoute(machineId, s.id);
      },
    },
    el(
      "div",
      { class: "card-top" },
      el("span", { class: "s-name", text: s.name || s.id }),
      s.kind ? el("span", { class: `kind-pill kind-${s.kind}`, text: s.kind }) : null,
      badge(state)
    ),
    el(
      "div",
      { class: "card-meta" },
      el("span", { class: "meta", text: basename(s.cwd) || "—" }),
      el("span", { class: "meta", text: s.model || "—" }),
      el("span", { class: `mode-tag mode-${mode}`, text: mode })
    )
  );

  // Swipe row: Delete sits behind the card, revealed by a right-to-left swipe
  // (also works with mouse drag for desktop testing). The Delete button is a
  // real button outside the card's gesture element; stopPropagation keeps it
  // clear of the card handlers entirely.
  const row = el(
    "div",
    { class: "swipe-row" },
    el("button", {
      class: "swipe-delete",
      type: "button",
      text: "Delete",
      "aria-label": `Delete session ${s.name || s.id}`,
      onclick: (e) => {
        e.stopPropagation();
        beginDelete(machineId, s, row);
      },
    })
  );
  const swipeCard = el("div", { class: "swipe-card" }, card);
  row.append(swipeCard);
  wireSwipe(
    row,
    swipeCard,
    () => {
      location.hash = attachRoute(machineId, s.id);
    },
    () => beginDelete(machineId, s, row)
  );
  return row;
}

// Bottom sheet listing machines, opened when the FAB acts with more than one
// machine connected. The spawn kind (temp/normal) comes from the FAB gesture;
// tapping a machine spawns there with it.
function machineSheet(machines, kind) {
  dismissSheet();
  const root = el("div", { class: "sheet-root" });
  activeSheet = root;
  const close = () => {
    if (activeSheet === root) activeSheet = null;
    root.remove();
  };
  const overlay = el("div", { class: "sheet-overlay", onclick: close });
  const panel = el(
    "div",
    { class: "sheet", role: "dialog", "aria-label": "Choose machine" },
    el("p", {
      class: "sheet-title",
      text: kind === "normal" ? "New normal session on…" : "New session on…",
    })
  );
  for (const entry of machines) {
    const machine = entry.machine || {};
    const mid = machine.id || "";
    const spawnOk = machine.spawnAvailable !== false;
    panel.append(
      el("button", {
        class: "sheet-item",
        type: "button",
        text: machine.hostname || mid,
        disabled: spawnOk ? null : "disabled",
        title: spawnOk ? null : "Spawn unavailable on this machine",
        onclick: () => {
          close();
          requestSpawn(mid, kind);
        },
      })
    );
  }
  root.append(overlay, panel);
  document.body.append(root); // outside #machine-list: survives re-renders
}

// The sheet floats above every view (document.body), so it must not outlive
// its context: dismiss on navigation, Escape, or any dashboard re-render.
let activeSheet = null;
function dismissSheet() {
  if (activeSheet) {
    activeSheet.remove();
    activeSheet = null;
  }
}
if (typeof document !== "undefined") {
  window.addEventListener("hashchange", dismissSheet);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismissSheet();
  });
}

// The single spawn entry point (one floating "+" button, bottom-right):
// tap -> temp (default), hold >= FAB_HOLD_MS -> normal. While holding, the
// button tints and its label flips to "Normal". Release before the hold
// threshold spawns a temp session.
function spawnFAB(machines) {
  const label = el("span", { class: "fab-label", text: "+" });
  const btn = el(
    "button",
    { class: "fab", type: "button", "aria-label": "New session" },
    label
  );
  if (machines.length === 0) {
    btn.disabled = "disabled";
    btn.title = "No machines connected";
    return btn;
  }

  let holdTimer = null;
  let holding = false;
  let activePointer = null;
  let pointerHandled = false; // a pointer gesture drove the action; swallow its click

  const resetVisual = () => {
    holding = false;
    btn.classList.remove("fab-hold");
    label.textContent = "+";
  };
  const clearHold = () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    activePointer = e.pointerId;
    pointerHandled = true;
    holding = false;
    try {
      btn.setPointerCapture?.(e.pointerId);
    } catch {}
    holdTimer = setTimeout(() => {
      holding = true;
      btn.classList.add("fab-hold"); // affordance: tint + label flip
      label.textContent = "Normal";
    }, FAB_HOLD_MS);
  });

  btn.addEventListener("pointerup", (e) => {
    if (activePointer === null || e.pointerId !== activePointer) return;
    activePointer = null;
    clearHold();
    const kind = holding ? "normal" : "temp";
    resetVisual();
    if (machines.length === 1) requestSpawn(machines[0].machine?.id || "", kind);
    else machineSheet(machines, kind);
  });

  btn.addEventListener("pointercancel", () => {
    activePointer = null;
    clearHold();
    resetVisual();
  });

  // The pointer handlers above own the action; kill the native click (and any
  // long-press menu) so nothing double-fires. Keyboard activation (Enter/
  // Space) fires click with NO pointer events — that must still spawn, so the
  // swallow is gated on a gesture having happened.
  btn.addEventListener("click", (e) => {
    if (!pointerHandled) {
      // Keyboard activation (no pointer events) = the tap semantic: temp.
      if (machines.length === 1) requestSpawn(machines[0].machine?.id || "", "temp");
      else machineSheet(machines, "temp");
      return;
    }
    pointerHandled = false;
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  return btn;
}

export function renderDashboard(container, reg, opts = {}) {
  if (typeof opts.refresh === "function") refreshHook = opts.refresh;
  container.replaceChildren();
  openRows.clear(); // detached rows from the previous render must not linger
  dismissSheet(); // a sheet left open over a stale registry is a trap
  const machines = reg && Array.isArray(reg.machines) ? reg.machines : [];

  if (machines.length === 0) {
    container.append(
      el(
        "div",
        { class: "empty" },
        el("p", { text: "No machines connected yet." }),
        el("p", {
          class: "dim small",
          text: "Start pi on a machine with the pi-remote extension installed.",
        })
      )
    );
  }

  for (const entry of machines) {
    const machine = entry.machine || {};
    const sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
    const mid = machine.id || "";

    const head = el(
      "div",
      { class: "machine-head" },
      el("h2", { text: machine.hostname || mid }),
      el("span", {
        class: "dim small",
        text: `${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
      })
    );

    const sec = el("section", { class: "machine" }, head);
    if (sessions.length === 0) {
      sec.append(el("p", { class: "dim small pad", text: "No sessions on this machine." }));
    } else {
      const list = el("div", { class: "session-list" });
      for (const s of sessions) list.append(sessionCard(mid, s));
      sec.append(list);
    }
    container.append(sec);
  }

  // One spawn button for the whole dashboard, rendered once per render.
  container.append(spawnFAB(machines));
}
