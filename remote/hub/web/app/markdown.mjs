// markdown.mjs — pure markdown → HTML renderer for the phone client.
//
// renderMarkdown(text) -> html string. No DOM at module level: import-safe and
// fully testable in plain Node (test/markdown.test.mjs). XSS BOUNDARY: model
// output is untrusted, so raw HTML in the source text is ESCAPED, never passed
// through — output is safe by construction. No DOMPurify, no CDN.
//
// Dependencies (vendored under ../vendor/, see ../vendor/VERSIONS.md):
//   - marked 18.1.2 (single-file ESM): parsed identically in Node and browser.
//   - Highlight.js 11.12.0 (UMD single file, core + common languages):
//       Node:   loaded here via createRequire(import.meta.url) + require() of
//               the UMD bundle. Works because hub/web/vendor/highlightjs/
//               package.json scopes {"type":"commonjs"} (repo root is
//               type:module, which would otherwise break require()).
//       Browser: hub/web/index.html loads the same file with a classic
//               <script defer src="vendor/highlightjs/highlight.min.js">
//               before the module graph, so window.hljs is set. This module
//               only READS window.hljs (never writes/creates globals).
//     Loading happens once at module top level (top-level await) so that
//     renderMarkdown stays synchronous. If loading fails, highlighting is
//     skipped and code renders escaped and plain — still safe.
//   - mermaid 12.2.0 dist is vendored too but is NOT imported here: it is
//     browser-only and dynamically imported by attach.mjs.
import { Marked } from "../vendor/marked/marked.esm.js";

// --- highlight.js load (once, top level; see header comment) ----------------

let hljs = null;
try {
  if (typeof process !== "undefined" && process.versions?.node) {
    const { createRequire } = await import("node:module");
    hljs = createRequire(import.meta.url)("../vendor/highlightjs/highlight.min.js");
  } else if (typeof window !== "undefined" && window.hljs) {
    hljs = window.hljs;
  }
} catch {
  hljs = null; // fallback: escaped plain code
}

// --- helpers ----------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

// HTML named entities that can smuggle or alter a URL scheme. Numeric refs of
// any kind are decoded generically below.
const SCHEME_ENTITIES = {
  amp: "&", colon: ":", semi: ";", sol: "/", bsol: "\\",
  tab: "\t", newline: "\n", "new-line": "\n",
  lt: "<", gt: ">", quot: '"', apos: "'", lpar: "(", rpar: ")",
};

// One HTML character-reference decode pass — mirrors how a browser decodes an
// attribute value exactly once. Never double-decodes: `&amp;#58;` must become
// the literal text `&#58;` (a relative URL, hence safe), not `:`.
function decodeEntitiesOnce(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body[0] === "#") {
      const cp = body[1] === "#" || body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), body[1] === "#" ? 10 : 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(SCHEME_ENTITIES, body) ? SCHEME_ENTITIES[body] : m;
  });
}

// Returns the href to output (attribute-escaped by the caller), or null when
// the scheme is not allowed — the caller then drops the anchor and keeps the
// link text. Allowed: http:, https:, mailto:, and scheme-less relative URLs.
function safeHref(raw) {
  if (typeof raw !== "string") return null;
  const decoded = decodeEntitiesOnce(raw);
  // Browsers ignore tabs/newlines (and trim controls/space) inside a URL;
  // strip them everywhere so `java\nscript:` cannot slip through the check.
  const probe = decoded.replace(/[\x00-\x20\x7f]/g, "");
  if (probe.startsWith("//")) return null; // protocol-relative: keep it out
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (!m) return raw; // relative URL
  const scheme = m[1].toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? raw : null;
}

// --- marked setup -----------------------------------------------------------

// Only characters that can legitimately appear in a language name survive;
// anything else (quotes, angle brackets, equals, entity bits) means "no
// language" — the class attribute stays unbreakable no matter what the model
// puts in the fence info string.
const langFirstWord = (lang) => {
  const w = (lang || "").match(/^\s*([^\s]+)/)?.[1] || "";
  return /^[\w.+#-]*$/.test(w) ? w.toLowerCase() : "";
};

function highlight(code, lang) {
  if (!hljs || !lang || !hljs.getLanguage(lang)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

const renderer = {
  // Raw HTML (block and inline): ESCAPE. This is the XSS boundary.
  html({ text }) {
    return escapeHtml(text);
  },

  // Fenced/indented code. mermaid is preserved verbatim (escaped) for the
  // client-side diagram renderer to pick up; everything else is highlighted.
  code({ text, lang }) {
    const l = langFirstWord(lang);
    if (l === "mermaid") {
      return `<pre><code class="language-mermaid">${escapeHtml(text)}</code></pre>`;
    }
    const cls = l ? `hljs language-${l}` : "hljs";
    return `<pre><code class="${cls}">${highlight(text, l)}</code></pre>`;
  },

  // Links: allowed schemes only, always open in a new tab. Dangerous schemes
  // (javascript:, vbscript:, data:, file:, …) are neutralized: the anchor is
  // dropped and the link text kept.
  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
    const safe = safeHref(href);
    if (safe == null) return inner;
    let a = `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"`;
    if (title) a += ` title="${escapeHtml(title)}"`;
    return a + `>${inner}</a>`;
  },

  // Images with dangerous src are reduced to their alt text.
  image({ href, title, text, tokens }) {
    const alt = escapeHtml(tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text);
    const safe = safeHref(href);
    if (safe == null) return alt;
    let img = `<img src="${escapeHtml(safe)}" alt="${alt}"`;
    if (title) img += ` title="${escapeHtml(title)}"`;
    return img + ">";
  },
};

const marked = new Marked({ renderer });

// --- public API -------------------------------------------------------------

// Markdown text (untrusted) -> safe HTML string. Synchronous, deterministic,
// total: never throws for any input; null/undefined/empty return "".
export function renderMarkdown(text) {
  if (typeof text !== "string" || text === "") return "";
  return marked.parse(text, { async: false, gfm: true, breaks: false });
}
