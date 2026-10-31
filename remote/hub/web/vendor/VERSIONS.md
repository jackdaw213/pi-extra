# Vendored assets

Every file here is pinned. The PWA must work with zero internet access — no CDN
references anywhere in hub/web. Sources below are the exact URLs the files were
fetched from. Re-vendor by re-running the same URL.

| File(s) | Package / version | Source URL | Fetched for |
|---|---|---|---|
| `marked/marked.esm.js` | marked 18.1.2 | `https://unpkg.com/marked@18.1.2/lib/marked.esm.js` | markdown parsing (pure ESM, Node + browser) |
| `highlightjs/highlight.min.js` | @highlightjs/cdn-assets 11.12.0 (Highlight.js 11.12.0, core + 36 common languages) | `https://unpkg.com/@highlightjs/cdn-assets@11.12.0/highlight.min.js` | syntax highlighting (UMD: Node `require` + browser global `hljs`) |
| `highlightjs/package.json` | local scope file, not a published artifact | — | Node scope only: repo root is `"type": "module"`; without `{"type":"commonjs"}` here Node would treat the UMD bundle as ESM and `require()` would return `{}` |
| `mermaid/mermaid.esm.min.mjs` | mermaid 12.2.0 | `https://registry.npmjs.org/mermaid/-/mermaid-12.2.0.tgz` (path `package/dist/mermaid.esm.min.mjs`) | client-side diagram rendering (browser only) |
| `mermaid/chunks/mermaid.esm.min/*.mjs` | mermaid 12.2.0 (104 chunk files, `.map` files excluded) | same tarball, path `package/dist/chunks/mermaid.esm.min/*.mjs` | imported relatively by `mermaid.esm.min.mjs`; must ship together |
