// Tiny DOM helpers + toasts. Browser only; import-safe from Node.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastHost = null;

export function initToastHost() {
  if (toastHost) return;
  toastHost = el("div", { class: "toasts", "aria-live": "polite" });
  document.body.append(toastHost);
}

export function toast(msg, kind = "info") {
  if (!toastHost) initToastHost();
  const t = el("div", { class: `toast toast-${kind}`, text: msg });
  toastHost.append(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 350);
  }, 3000);
}

// State badge: idle gray, working blue (pulsing), blocked orange, offline dim.
export function badge(state) {
  return el(
    "span",
    { class: `badge st-${state || "idle"}` },
    el("i", { class: "dot", "aria-hidden": "true" }),
    state || "idle"
  );
}
