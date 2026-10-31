// Tests for the pure markdown→HTML seam used by the phone client
// (hub/web/app/markdown.mjs). Scenario mapping (features/pi-remote-phone-ui.feature):
//   - "Assistant reply renders markdown"  → bold/list/code tests below
//   - "Table renders as a table"          → table test
//   - "Mermaid renders as a diagram"      → mermaid preservation + fallback clause
//   - "Model-sent HTML never executes"    → escaping tests
//   - "Streaming renders progressively"   → covered at the attach.mjs seam (browser);
//                                             here we pin renderMarkdown's purity + sync output.
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../hub/web/app/markdown.mjs";

// --- bold / lists / inline code ("Assistant reply renders markdown") --------

test("bold text renders as <strong> and raw asterisks do not survive", () => {
  const html = renderMarkdown("This is **important** stuff");
  assert.match(html, /<strong>important<\/strong>/);
  assert.ok(!html.includes("**"), "raw markdown syntax must not appear");
});

test("italic text renders as <em>", () => {
  const html = renderMarkdown("run the *quick* check");
  assert.match(html, /<em>quick<\/em>/);
});

test("list renders as real ul/li", () => {
  const html = renderMarkdown("items:\n\n- alpha\n- beta\n");
  assert.match(html, /<ul>/);
  assert.match(html, /<li>alpha<\/li>/);
  assert.match(html, /<li>beta<\/li>/);
});

test("headings and blockquotes render as standard markdown", () => {
  const html = renderMarkdown("# Title\n\n> quoted note");
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /quoted note/);
});

test("inline code renders as <code> and escapes its content", () => {
  const html = renderMarkdown("use `npm run <script>` here");
  assert.match(html, /<code>npm run &lt;script&gt;<\/code>/);
});

// --- tables ("Table renders as a table") -------------------------------------

test("table renders as a real table with rows and no visible pipes", () => {
  const md = [
    "| Name | Age |",
    "|------|-----|",
    "| Ana  | 31  |",
    "| Bo   | 9   |",
  ].join("\n");
  const html = renderMarkdown(md);
  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>Name<\/th>/);
  assert.match(html, /<td[^>]*>Ana<\/td>/);
  assert.match(html, /<tr>/);
  assert.ok(!html.includes("|"), "table pipe characters must not remain visible");
});

// --- code blocks with highlighting -------------------------------------------

test("fenced code block is highlighted with hljs markup", () => {
  const md = "```js\nconst x = 1;\n```\n";
  const html = renderMarkdown(md);
  assert.match(html, /<pre><code class="hljs language-js">/);
  assert.match(html, /<span class="hljs-/); // highlighter ran
  assert.match(html, /const/);
});

test("unknown code language falls back to escaped plain code, still safe", () => {
  const md = "```nosuchlang\na < b && c > d\n```\n";
  const html = renderMarkdown(md);
  assert.match(html, /<pre><code class="hljs language-nosuchlang">/);
  assert.ok(!html.includes("<span"), "unknown language must not be auto-highlighted");
  assert.ok(html.includes("a &lt; b &amp;&amp; c &gt; d"), "code must be escaped");
});

test("code block content is escaped even when it contains html", () => {
  const md = "```html\n<script>alert(1)</script>\n```\n";
  const html = renderMarkdown(md);
  assert.ok(!/<script/i.test(html), "no live script tag may appear");
  // hljs escapes while highlighting, splitting the tag with spans:
  // `<span class="hljs-tag">&lt;<span class="hljs-name">script</span>&gt;` —
  // so assert the escaped opening bracket and escaped name appear.
  assert.ok(html.includes("&lt;"), "tag characters must be escaped");
  assert.ok(html.includes('hljs-name">script<'), "script shows as highlighted text");
});

// --- mermaid ("Mermaid renders as a diagram", fallback clause) ---------------

test("mermaid block is preserved verbatim, un-highlighted, escaped", () => {
  const src = "graph TD\n  A[Bold <b>label</b>] --> B{Choice}";
  const md = "```mermaid\n" + src + "\n```\n";
  const html = renderMarkdown(md);
  assert.match(html, /<pre><code class="language-mermaid">/);
  assert.ok(!html.includes("hljs-"), "mermaid source must not be highlighted");
  assert.ok(html.includes("A[Bold &lt;b&gt;label&lt;/b&gt;]"), "source preserved, escaped");
  assert.ok(!html.includes("<b>label"), "no raw html from mermaid source");
});

// --- XSS boundary ("Model-sent HTML never executes") --------------------------

test("inline html in source renders as escaped text, never markup", () => {
  const html = renderMarkdown("hello <b onclick=\"x()\">world</b>, bye");
  assert.ok(!/<b[ >]/i.test(html), "raw inline html must not become markup");
  assert.ok(html.includes("&lt;b"), "html must appear escaped as text");
});

test("script tag in source appears escaped and inert", () => {
  const html = renderMarkdown("<script>alert('xss')</script>\n\nand <img src=x onerror=alert(2)>");
  assert.ok(!/<script/i.test(html), "script tag must not survive");
  assert.ok(!/<img/i.test(html), "img tag must not survive");
  assert.ok(html.includes("&lt;script&gt;"), "script tag shows as text");
  assert.ok(html.includes("&lt;img"), "img tag shows as text");
});

test("html in block position is escaped too", () => {
  const html = renderMarkdown("<div><p>block html</p></div>");
  assert.ok(!/<div>|<p>/i.test(html));
  assert.ok(html.includes("&lt;div&gt;"));
});

// --- links ---------------------------------------------------------------------

test("normal links render as anchors with target=_blank and rel=noopener noreferrer", () => {
  const html = renderMarkdown("see [the docs](https://example.com/a) and [local](./x.md)");
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">the docs<\/a>/
  );
  assert.match(
    html,
    /<a href="\.\/x\.md" target="_blank" rel="noopener noreferrer">local<\/a>/
  );
});

test("javascript: link scheme is neutralized — anchor dropped, text kept", () => {
  const html = renderMarkdown("[click me](javascript:alert(1))");
  assert.ok(!/href\s*=/i.test(html), "no href may point anywhere");
  assert.ok(!/javascript:/i.test(html), "javascript scheme must not survive");
  assert.ok(html.includes("click me"), "link text survives as plain content");
});

test("dangerous data:/vbscript: link schemes are neutralized too", () => {
  for (const href of ["data:text/html;base64,PHNjcmlwdD4=", "vbscript:msgbox(1)"]) {
    const html = renderMarkdown(`[x](${href})`);
    assert.ok(!/href\s*=/i.test(html), `scheme must be neutralized: ${href}`);
  }
});

test("scheme hidden behind html entities is still neutralized", () => {
  // Attribute values are entity-decoded by the browser before the URL is used.
  const html = renderMarkdown("[x](javascript&colon;alert(1))");
  assert.ok(!/href\s*=/i.test(html), "entity-disguised scheme must be neutralized");
});

// --- contract: pure, synchronous, total ----------------------------------------

test("empty, null and undefined input return a safe string without throwing", () => {
  for (const input of ["", null, undefined]) {
    const html = renderMarkdown(input);
    assert.equal(typeof html, "string");
    assert.ok(!/<script/i.test(html));
  }
});

test("renderMarkdown is deterministic (same input, same output)", () => {
  const md = "# t\n\n- a\n\n```js\nlet v=1;\n```";
  assert.equal(renderMarkdown(md), renderMarkdown(md));
});

// Regression (review finding): the fence info string is untrusted model
// output. A hostile first word must not break out of the class attribute.
test("hostile fence info string cannot break out of the class attribute", () => {
  const html = renderMarkdown('```"><svg/onload=alert(1)>\nx\n```');
  assert.ok(!html.includes("<svg"), "raw tag must not survive");
  assert.ok(!html.includes('language-">'), "attribute must not break open");
  assert.ok(html.includes('class="hljs"'), "unknown language falls back safely");
});
