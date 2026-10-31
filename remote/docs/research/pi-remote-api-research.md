# pi-remote API research

Researched against the installed Pi-Bolt dist (compiled from `@earendil-works/pi-coding-agent` **1.4.0**) and the checked docs/examples shipped with it. Dist root abbreviated **`$DIST`** = `/home/jackdaw/.cache/pibolt-kit/pi-bolt-kit-linux-x64/tree/packages/coding-agent/dist`. Docs root abbreviated **`$DOCS`** = `/home/jackdaw/.cache/pibolt-compiled/docs`, examples **`$EX`** = `/home/jackdaw/.cache/pibolt-compiled/examples/extensions`. The dist ships no `.d.ts` files; exact TypeScript signatures were verified from upstream `packages/coding-agent/src/core/extensions/types.ts` (GitHub `earendil-works/pi`, fetched 2025 via raw.githubusercontent.com), cited below as `types.ts`.

## Summary

An extension is a TypeScript module whose default factory receives a `pi` API object and runs inside every pi session, including TUI, RPC, JSON, and print modes. It can register tools and commands, subscribe to the full lifecycle event stream (including token-by-token assistant deltas and terminal-typed user input), send user or custom messages that trigger or steer turns, read session identity from `ctx.sessionManager`, and render arbitrary multi-line TUI components (a QR code) via `ctx.ui.custom()` in interactive mode. The extension may import node builtins and npm deps resolved by jiti from a nearby `package.json`; herdr (a built-in Pi-Bolt extension) proves real sockets and process spawning work from extension code. New headless sessions are spawned with `pi --mode rpc` (JSONL on stdin/stdout, no TTY needed) — the subagent example is working prior art; no built-in HTTP server or remote-control mechanism exists in pi itself, so an HTTP+WebSocket server must live in the extension. Factories must not start sockets or timers; long-lived resources belong in `session_start`, released by an idempotent `session_shutdown` handler.

---

## Q1. Message injection: `pi.sendUserMessage()` and `pi.sendMessage()`

### Exact signatures (types.ts, `ExtensionAPI`)

```ts
sendMessage<T = unknown>(
  message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
): void;

sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
): void;
```
Source: upstream types.ts (`ExtensionAPI`, "Send a custom message" / "Send a user message" blocks); same option sets documented in `$DOCS/extensions.md` ("Send user or custom messages | `pi.sendUserMessage()` or `pi.sendMessage()`").

### Semantics

`sendUserMessage` (runtime: `$DIST/core/agent-session.js:2038-2066`):
- Normalizes content to text + optional images, then calls `prompt(text, { expandPromptTemplates: options?.expandPromptTemplates ?? false, streamingBehavior: options?.deliverAs, images, source: "extension" })` (`agent-session.js:2060-2066`). Note the default: **template expansion is off** for extension sends (opposite of typed prompts).
- `prompt()` (`agent-session.js:1759-1822`):
  - **Idle**: validates model/auth, then `_startRun({ messageType: "user", prompt, images })` — a full new turn. (`agent-session.js:1821`)
  - **Streaming (agent busy)**: **throws** `Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")` unless `deliverAs` is given (`agent-session.js:1793-1796`). With `deliverAs:"steer"` → `_queueSteer` (`agent-session.js:1798-1801`); `"followUp"` → `_queueFollowUp`.
  - Extension commands (`/cmd`) are executed immediately even while streaming (`agent-session.js:1768-1777`).
- The doc-comment at `agent-session.js:2035-2037` states: "Send a user message to the agent. **Always triggers a turn.** When the agent is streaming, use deliverAs to specify how to queue the message."
- Steering queue semantics: steer is "delivered after the current assistant turn finishes executing its tool calls, before the next LLM call"; followUp is "delivered only when agent has no more tool calls or steering messages" (`agent-session.js:1901-1930`). Queued messages appear to the client via the `queue_update` event (`agent-session.js:749-755`).
- Transcript: steered/follow-up messages enter the agent as `role:"user"` messages with content `[{type:"text",text}, ...images]` (`agent-session.js:1949-1978`), then persist and emit `message_start`/`message_end` like any user message (event flow in `$DOCS/json.md`, "Event sequence"). `sendUserMessage` messages "appear in the conversation as if typed by the user" (`$EX/send-user-message.ts:5-7`).

`sendMessage` (runtime: `sendCustomMessage`, `$DIST/core/agent-session.js:1948-2012`):
- Creates a `CustomMessageEntry` (role `"custom"`, with `customType`, `content`, `display`, `details`) — a distinct transcript entry type, not a user message (`agent-session.js:1980-1990`, docs `$DOCS/extensions.md` "Custom content stored and sent to the model | `pi.sendMessage()`").
- Busy behavior (`agent-session.js:1985-2000`):
  - `deliverAs:"nextTurn"` → parked in `_pendingNextTurnMessages`.
  - Streaming + `triggerTurn !== false` → **steered by default** (`agent.followUp()` for `"followUp"`, otherwise `agent.steer()`).
  - Streaming without a trigger → appended to state/session at end of turn (`_pendingCustomMessages`), no turn.
  - Idle + `triggerTurn:true` → `_startRun({ messageType: "custom", message })` — starts a turn whose `before_agent_start` event has `messageType:"custom"` (types.ts, `BeforeAgentStartCustomEvent`).
  - Idle, no trigger → appended only; no LLM call (`agent-session.js:2001-2012`).
- Custom messages can carry image content: `content` accepts `string | (TextContent|ImageContent)[]` (types.ts, `CustomMessageEntryDraft` and `ReplacedSessionContext.sendMessage`).

### Extension-facing wiring

`pi.sendMessage`/`pi.sendUserMessage` are bound to the session at `$DIST/core/agent-session.js:2962-2973` (`runner.bindCore`), delegated in the loader at `$DIST/core/extensions/loader.js:313-322`. Errors are reported as `send_message`/`send_user_message` extension errors (`agent-session.js:2963-2971`). Working example with all three delivery modes: `$EX/send-user-message.ts` (guards with `ctx.isIdle()` because streaming sends without `deliverAs` throw).

### How to trigger a turn from a remote client

Phone → HTTP/WebSocket → our extension handler → `pi.sendUserMessage(text)` when `ctx.isIdle()`, or `pi.sendUserMessage(text, { deliverAs: "steer" | "followUp" })` when busy (mode chosen by the phone or by policy). Alternative: `pi.sendMessage({ customType, content, display, details }, { triggerTurn: true })` for an out-of-band custom entry, or queue-only custom notes with `triggerTurn:false`. To let the phone drive extension commands, `pi.sendUserMessage("/cmd args", { expandPromptTemplates: true })` dispatches them (`agent-session.js:2060-2063` + `prompt()` command dispatch at `1768-1777`).

## Q2. Output streaming: reconstructing a live view

### Extension-side events (all handlers receive `(event, ctx)`; `$DIST/core/extensions/runner.js:855-920` `emit`/`dispatch`)

| Event | Payload | Source |
|---|---|---|
| `agent_start` | `{type:"agent_start"}` | `agent-session.js:1010` |
| `turn_start` | `{type:"turn_start", turnIndex, timestamp}` | `agent-session.js:1019-1026` |
| `message_start` | `{type:"message_start", message}` — fires for **user, assistant, and toolResult** messages (types.ts, `MessageStartEvent`) | `agent-session.js:1032-1038` |
| `message_update` | `{type:"message_update", message: partial AssistantMessage, assistantMessageEvent}` — **token-by-token** (types.ts, `MessageUpdateEvent`) | `agent-session.js:1040-1049` |
| `message_end` | `{type:"message_end", message}`; handlers may replace the message (same role) | `agent-session.js:1050-1073`, `runner.js:974-1008` |
| `tool_execution_start` | `{toolCallId, toolName, args}` | `agent-session.js:1074-1082` |
| `tool_execution_update` | `{toolCallId, toolName, args, partialResult}` | `agent-session.js:1083-1091` |
| `tool_execution_end` | `{toolCallId, toolName, result, isError, durationMs?}` | `agent-session.js:1092-1101` |
| `agent_end` | `{type:"agent_end", messages}` — **not** a final-idle signal (retries/steering/follow-ups can continue) | `agent-session.js:1013` |
| `agent_settled` | `{type:"agent_settled", aborted}` — Pi will not continue automatically; the "run finished" signal | `agent-session.js:784-785` |
| `queue_update` | `{steering: string[], followUp: string[]}` | `agent-session.js:749-755` |

### Real-time text deltas: yes

The agent loop emits one `message_update` per provider delta with `assistantMessageEvent` of types `text_start | text_delta | text_end | thinking_start | thinking_delta | thinking_end | toolcall_start | toolcall_delta | toolcall_end` (`$DIST/packages/agent/dist/agent-loop.js:387-406` — local tree `tree/packages/agent/dist/agent-loop.js`). Delta shape: `{ type:"text_delta", contentIndex, delta: string, partial }` (`tree/packages/ai/dist/api/anthropic-messages.js:434-457`). So the extension can forward `event.assistantMessageEvent.delta` per chunk over the WebSocket immediately. Handler note: `dispatch()` avoids an await per event when handlers return synchronously (`runner.js:855-920`, comment "Streaming emits an event per delta"); docs warn notification handlers must not do slow work on streaming events (`$DOCS/extensions.md`, "Events and concurrency").

### Terminal-typed user prompts: yes, via `input`

The `input` event fires for every prompt before processing: `{type:"input", text, images?, source: "interactive" | "rpc" | "extension", streamingBehavior?}` (`runner.js:1311-1341`; types.ts `InputEvent`, `InputSource`). RPC prompts carry `source:"rpc"` (`$DIST/modes/rpc/rpc-mode.js:296-322`), extension sends `source:"extension"` (`agent-session.js:2065`). So the phone can mirror what is typed in the terminal and tag message origin. `before_agent_start` additionally distinguishes `messageType:"user"` (prompt/images) vs `"custom"` (types.ts, `BeforeAgentStartUserEvent`/`BeforeAgentStartCustomEvent`). `ui_prompt_start`/`ui_prompt_end` expose extension dialogs (used by herdr, `$DIST/extensions/herdr/index.js:157-165`). The raw terminal editor contents are NOT otherwise exposed to extensions (only `onTerminalInput` for raw key events, types.ts `ExtensionUIContext`, interactive mode only).

## Q3. Terminal QR rendering via `ctx.ui.custom()`

- **Component API**: `ctx.ui.custom<T>(factory, options?)` where `factory(tui, theme, keybindings, done)` returns a component `{ render(width): string[], handleInput?(data), invalidate?(), dispose?() }`; `done(result)` resolves the promise. Options: `{ overlay?: boolean, overlayOptions?, onHandle?(handle), blocked? }` (types.ts, `ExtensionUIContext.custom`). `render()` returns an **array of terminal lines** — a QR code as multi-line ASCII/block art fits directly (every line must fit `width`; use `truncateToWidth`). Reference implementation: `$DOCS/tui.md` "Build a minimal custom screen" (complete example). Components can also be composed from `@earendil-works/pi-tui` (`Text`, `Box`, `Container`, ...) — `$DOCS/tui.md` "Compose built-in components".
- **Multi-line ASCII art / small dialog with text**: yes — `render()` lines are arbitrary themed strings; `theme.fg()`/`theme.bg()` for styling (`$DOCS/tui.md`). Examples: `$EX/custom-footer.ts` (footer component rendering lines), `$EX/entry-renderer.ts` (Box+Text composition), `$EX/doom-overlay/index.ts` ("overlays can handle real-time game rendering at 35 FPS" — a static QR is trivial by comparison), `$EX/overlay-qa-tests.ts` (overlay positioning).
- **Mode requirement**: custom components work **only in interactive TUI mode**. "RPC can forward supported dialogs and notifications through the RPC Extension UI protocol, but not custom terminal components; JSON and print modes have no UI. Guard terminal-only behavior with `ctx.mode === "tui"` and use `ctx.hasUI` for interactions supported by interactive and RPC clients" (`$DOCS/extensions.md`, "UI and modes"). Both checked examples guard with `if (ctx.mode !== "tui") { ctx.ui.notify(..., "error"); return; }` (`$EX/doom-overlay/index.ts:29-32`, `$DOCS/tui.md` minimal screen). So QR pairing must degrade in RPC mode: e.g. print the QR/URL to stderr, or serve it over the phone's own HTTP endpoint.
- **Non-blocking alternative**: `ctx.ui.setWidget(key, content | factory, { placement })` renders persistent content above/below the editor (types.ts `ExtensionUIContext.setWidget`; `$EX/widget-placement.ts`) — could show pairing status persistently without stealing focus. Overlay QR after `/pair` command is the closest fit.

## Q4. Extension dependencies and jiti

- **Discovery & manifest**: an extension dir is loaded from (1) `package.json` with a `"pi"` field: `{ "pi": { "extensions": ["./index.ts"] } }`, or (2) `index.ts`/`index.js` fallback; single files `*.ts|*.js` also load; one level deep, no recursion (`$DIST/core/extensions/loader.js:692-760`, `resolveExtensionEntries`/`discoverExtensionsInDir`). Standard locations: `<cwd>/.pi/extensions/` then `~/.pi/agent/extensions/`, then explicit `--extension` paths (`loader.js:762-795`).
- **npm deps**: "Put npm dependencies in a nearby `package.json`" (`$DOCS/extensions.md`, "Add it to Pi"). Checked example `$EX/with-deps/`: `package.json` declares `"pi": {"extensions": ["./index.ts"]}` plus `"dependencies": {"ms": "2.1.3"}`, and `index.ts` does `import ms from "ms"` — "Tests that jiti resolves modules from the extension's own node_modules" (`$EX/with-deps/index.ts:1-5`). Requires `npm install` in that directory (header comment). For distributed packages, `pi install` installs `dependencies` automatically; host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) must go in `peerDependencies: "*"` and never in `dependencies` (`$DOCS/packages.md:80-96`).
- **jiti mechanics**: extensions are imported via jiti with `moduleCache: false`, TypeScript compiled on the fly, transform cache at `~/.pi/agent/cache/jiti`; pi packages are provided through jiti `virtualModules` (embedded modules) or alias maps (`loader.js:505-535`, `extensionTransformCache()` at 495-503). Failure hint strings mention a JIT requirement path (`runner.js:1038-1041`).
- **Node builtins**: yes. Herdr uses `node:path`, `node:net` (Unix-socket transport via `process.getBuiltinModule("node:net").createConnection`), and `node:child_process.spawn` (`$DIST/extensions/herdr/transport.js:1-64`); `$EX/ssh.ts` imports `node:child_process`; `$EX/subagent/index.ts` imports `node:fs`, `node:os`, `node:path`. The loader itself uses `node:fs`/`node:path` (`loader.js`). `node:http`/`node:crypto` are ordinary builtins — no restriction found anywhere in the runtime; extensions run in-process with full OS permissions (`$DOCS/extensions.md`, opening paragraph).

## Q5. Headless sessions via RPC mode

- **Start**: `pi --mode rpc [--no-session] [--session <path|id>] [--session-dir <dir>] [--name <name>] [--provider X --model Y] [--extension ...]` (`$DOCS/rpc.md` "Start RPC mode"; flag table `$DIST/cli/args.js:310-331`; `--mode rpc` parsing at `args.js:51-58`). Sessions land in the standard place by default: `~/.pi/agent/sessions/` grouped per working directory (`$DOCS/sessions.md` "Control session storage"; default dir logic `$DIST/core/session-manager.js:323-330`); `--session-dir`/`--name` control location and display name. `--no-session` = ephemeral. **RPC mode rejects `@file` CLI arguments** (`$DOCS/rpc.md`).
- **No TTY needed**: `resolveAppMode` maps `--mode rpc` to the rpc app mode unconditionally — it never inspects a TTY for rpc (`$DIST/main.js:90-106`; interactive selection only when `mode === undefined` at `main.js:106`). `runRpcMode` reads JSONL from stdin and writes to stdout (`rpc-mode.js:27-31`); docs say "runs Pi as a long-lived subprocess controlled through JSON records on stdin and stdout" (`$DOCS/rpc.md`). Therefore it runs fine under `systemd-run` with piped stdio.
- **Readiness**: there is **no ready/banner record** — stdout is reserved for protocol records and stderr for diagnostics (`$DOCS/rpc.md` "Framing"). Practical readiness probe: send `{"type":"get_state"}` and await its `response`. Sessions may also start in-memory and only persist after the first user/assistant message (`session-manager.js:1206-1216`), so `get_state.sessionFile` can be empty early.
- **Command set** (full details `$DOCS/rpc-commands.md`): `prompt` (message, optional `images[]`, `streamingBehavior:"steer"|"followUp"` when busy; response `data.disposition: "handled"|"queued"|"started"`), `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state` (returns `model`, `thinkingLevel`, `isStreaming`, `sessionFile`, `sessionId`, `sessionName`, `pendingMessageCount`...), `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level` (+cycle/list), `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash` (streams `bash_execution_update`; output reaches the LLM on the next prompt unless `excludeFromContext`), `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries` (append-ordered with durable `since` cursor + `leafId`), `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`.
- **Event stream a bridge must relay** (`$DOCS/json.md`, shared by JSON and RPC): `agent_start`, `turn_start`, `message_start`/`message_update`/`message_end` (wire `message_update` is delta-only; `assistantMessageEvent` of `text_delta|thinking_delta|toolcall_*` with `contentIndex`/`delta`; reconstruct by buffering deltas, replace at `*_end`, replace whole message at `message_end`), `turn_end`, `agent_end` (`willRetry`), `agent_settled` (`aborted`), `queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed`, `compaction_start`/`compaction_end`, `auto_retry_start`/`auto_retry_end`, `summarization_retry_*`, plus RPC-only `bash_execution_update` (`{id, delta}`) and `extension_error`. RPC has no session header record; use `get_state`.
- **Protocol hygiene** (`$DOCS/rpc.md`): strict JSONL, LF-terminated, do not use Node `readline` (splits on U+2028/2029); read stdout continuously (backpressure can stall pi); correlate commands via `id`; `prompt` success ≠ run complete — wait for `agent_settled`; shutdown by closing stdin. TypeScript client prior art: `$EX/../rpc-client.ts` (checked example, `examples/rpc-client.ts`).
- **Spawning prior art**: `$EX/subagent/index.ts:296-345` spawns `pi --mode json -p --no-session ...` per subagent with `spawn(command, args, {stdio:["ignore","pipe","pipe"]})` and parses the event stream — direct precedent for launching headless pi processes from an extension. `pi.exec(command, args, {cwd, signal, timeout})` is also available in-process (spawn, no shell; `$DIST/core/extensions/loader.js:355`, `$DIST/core/exec.js:14-60`). Wrap the launch in `systemd-run --user --scope ...` at the spawn site (sandbox properties are a pi-remote concern, not pi's; pi documents Docker/Gondolin isolation only, `$DOCS/containerization.md`).

## Q6. Session identity from inside an extension

- `ctx.sessionManager` is a **ReadonlySessionManager** (types.ts, `ExtensionContext`). Verified getters (`$DIST/core/session-manager.js`):
  - `getSessionId()` (`:1199`), `getSessionFile()` (`:1202`), `getCwd()` (`:1190`), `getSessionDir()` (`:1193`), `usesDefaultSessionDir()` (`:1196`), `isPersisted()` (`:1187`), `getSessionName()` (`:1371`), `getBranch(fromId?)` (`:1499`), `getEntries()`/tree accessors (used by custom-footer.ts and docs).
  - Live usage example: herdr reads `ctx.sessionManager.getSessionFile()` and `getSessionId()` on `session_start`/`agent_start` (`$DIST/extensions/herdr/index.js:90-105`).
- Model: `ctx.model` (`Model | undefined`), `ctx.scopedModels`, `ctx.thinkingLevel`, `ctx.cwd`, `ctx.modelRegistry` (types.ts `ExtensionContext`; runner `createContext()` `$DIST/core/extensions/extensions/runner.js:659-728` — note path `$DIST/core/extensions/runner.js:659-728`). Session name can also be set via `pi.setSessionName(name)` / read via `pi.getSessionName()` (`loader.js:323-330`).
- Default transcript location: `~/.pi/agent/sessions/<safe-cwd-path>` (`session-manager.js:323-330`); file is created lazily on first user/assistant message (`session-manager.js:1206-1216`).
- **Session end**: `session_shutdown` event = `{ type:"session_shutdown", reason: "quit" | "reload" | "new" | "resume" | "fork", targetSessionFile? }` (types.ts `SessionShutdownEvent`). Emitted by `teardownCurrent()` for new/fork/resume (`$DIST/core/agent-session-runtime.js:100-115`), reload (`agent-session.js:3197`), and quit (`agent-session-runtime.js:292-303`). Herdr treats `reason !== "quit"` as "another session continues in this process" and only releases the pane on `"quit"` (`herdr/index.js:196-207`) — the same pattern applies to a registry: unregister the session only on `quit`, re-register on the next `session_start`.
- `session_start` = `{type:"session_start", reason: "startup"|"reload"|"new"|"resume"|"fork", previousSessionFile?}` (types.ts `SessionStartEvent`; `agent-session-runtime.js:165`).
- **Process exit**: graceful paths (signals SIGINT/SIGTERM/SIGHUP/SIGBREAK) run `runtimeHost.dispose()` which emits `session_shutdown` before exit (`$DIST/modes/interactive/interactive-mode.js:3535-3545,3630-3645`); `SIGKILL` or a crash gives no event — the registry must also treat a dead HTTP connection / child exit as implicit end. `ctx.shutdown()` requests orderly shutdown from inside an extension (`runner.js:646-651`, types.ts).

## Q7. File transfer into and out of sessions

**Into a session:**
- `@file` references are a **CLI-argument feature only** (`pi [@files...]`, `$DOCS/cli.md:8`) and **rejected in RPC mode** (`$DOCS/cli.md:51`, `$DOCS/rpc.md`). They are not part of the extension message APIs.
- **Images in prompts**: `ImageContent { type:"image", data: <base64>, mimeType }` (`$DOCS/message-types.md:27-35`). Accepted by: RPC `prompt`/`steer`/`follow_up` `images` fields (`$DOCS/rpc-commands.md` "prompt"/"steer"), `pi.sendUserMessage(text | (TextContent|ImageContent)[])` (`agent-session.js:2038-2060`, types.ts), and `pi.sendMessage` content arrays (types.ts `CustomMessageEntryDraft`). The extension downloads the phone's bytes and injects them as base64 — no temp-file detour needed for images.
- **Other files**: no "attach file" extension API exists. Working pattern: the extension writes the file to disk (it has `node:fs`), then injects a prompt that names the absolute path (the agent's built-in `read` tool reads it), optionally wrapped in instructions. This is the pattern the subagent example uses for system prompts (writes a temp file and passes `--append-system-prompt <path>`, `$EX/subagent/index.ts:319-327`).

**Out of a session (tool hands bytes to the extension):**
- A custom tool's `execute(toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext)` runs **in-process inside the extension's own module closure** (types.ts `ToolDefinition.execute`; tools are registered by the same extension, `loader.js:258-267`, wrapped at `$DIST/core/extensions/wrapper.js:8-27`). So a registered tool (e.g. `share_file(path)`) can read the bytes itself and push them straight to the connected WebSocket clients or a download spool, then return `{content:[{type:"text",...}], details:{...}}` to the model. No other relay is needed.
- Alternative: the extension listens to `tool_execution_end` for a chosen tool name and forwards `event.result`/`event.result.details.filePath` (payload at `agent-session.js:1092-1101`). `tool_result` handlers may also rewrite `content`/`details`/`structuredContent` (`runner.js:1010-1066`).

## Q8. Lifecycle rules

- **Factory purity**: "Do not start processes, sockets, watchers, or timers in the factory because some invocations load extensions without starting a session. Start long-lived resources from `session_start` or from the command or tool that needs them. Close session-scoped resources from an idempotent `session_shutdown` handler." (`$DOCS/extensions.md`, "Understand the runtime lifecycle".) The factory may be async and can register providers, but nothing long-lived.
- **Idempotent shutdown**: "Release resources in `session_shutdown` even when normal operation attempted cleanup. Keep cleanup idempotent because cancellation, reload, session replacement, and process exit can converge on the same path." (`$DOCS/extensions.md`, "Errors and cleanup".) Confirmed by the runtime: `teardownCurrent()` aborts, emits `session_shutdown`, then disposes; reload also emits it (`agent-session-runtime.js:100-115`; `agent-session.js:3197`).
- **`ctx.mode`**: available in every handler ctx — `"tui" | "rpc" | "json" | "print"` (types.ts `ExtensionMode`, `ExtensionContext.mode`; runtime `$DIST/core/extensions/runner.js:665-668`, default `"print"` at runner.js:171 until bound). Guard terminal UI with `ctx.mode === "tui"` (`$DOCS/extensions.md` "UI and modes").
- **`ctx.hasUI`**: boolean getter on ctx — "Whether dialog-capable UI is available (**true in TUI and RPC modes**)" (types.ts; runner `hasUI()` returns `uiContext !== noOpUIContext`, `runner.js:436-438`, ctx getter `runner.js:673-675`; the no-op UI stub at `runner.js:152-190`). RPC dialogs/notifications are forwarded to the RPC client via the Extension UI subprotocol (`$DOCS/extensions.md`; `$DOCS/rpc-extension-ui.md`).

## Q9. Prior art and built-in remote mechanisms

- **herdr** (`$DIST/extensions/herdr/`, built into Pi-Bolt): a pane-manager integration (herdr.dev). It reports agent state (`idle|working|blocked`) + resume command to Herdr over a **Unix socket opened from extension code** (`transport.js` socketTransport) or by spawning the `herdr` binary. Prior art for: socket transport in an extension, session identity reads, `session_shutdown.reason` handling, extension→extension event bus usage (`pi.events.on("herdr:blocked")`, `subagents:started`). It is **not** remote control — it only reports state.
- **subagent example** (`$EX/subagent/`): spawns separate headless `pi --mode json -p --no-session` processes per task and parses their event streams — closest prior art for requirement (e) (launching new headless sessions from an extension).
- **ssh.ts** (`$EX/ssh.ts`): routes built-in tool operations to a remote machine over SSH — precedent for delegating tool execution, not for HTTP serving.
- **rpc-demo.ts** (`$EX/rpc-demo.ts`) and `examples/rpc-client.ts`: RPC client examples (subprocess control of pi, not network serving).
- **No built-in HTTP server**: grep for `createServer|node:http` across `$DIST` matches only bundled provider/upload chunks (e.g. bug-report upload, model SDKs); `utils/management-http.js` is an HTTP **client** fetch helper ("fetch a management HTTP resource", header comment). No extension-facing server API exists.
- **`/share`** is upload-only session export (HTML/JSONL to a Radius artifact or private GitHub gist) — a viewer link, not live control (`$DOCS/sessions.md:56-58`).
- **RPC/ACP/MCP modes** are pi's built-in "remote control" — subprocess stdin/stdout protocols, not network servers (`$DOCS/rpc.md` interface table). ACP (`--mode acp`) targets editors; MCP (`--mode mcp`) exposes pi as an MCP server to other agents; both remain stdio-bound.
- **`pi.events`**: in-process event bus for extension↔extension messaging (`$EX/event-bus.ts`; `loader.js:444-456`) — useful if pi-remote is split across cooperating extensions, not for cross-process use.

## Q10. Version

- `@earendil-works/pi-coding-agent` **version 1.4.0** (`/home/jackdaw/.cache/pibolt-kit/pi-bolt-kit-linux-x64/tree/packages/coding-agent/package.json`, `name`/`version` fields). The `with-deps` example in the same tree also pins `"version": "1.4.0"`. **The spec should target this API surface as of 1.4.0.**

---

## Risks & unknowns

1. **No `.d.ts` in dist; exact types from upstream `main`.** The installed dist is compiled JS; TypeScript signatures were taken from `github.com/earendil-works/pi` `packages/coding-agent/src/core/extensions/types.ts` at `main`. If main has drifted past 1.4.0, individual signatures could differ slightly (runtime behavior cited from dist is authoritative; only `types.ts` shapes carry this risk).
2. **HTTP/WebSocket server lifecycle untested here.** Nothing in the runtime forbids `node:http` in an extension, but no checked example serves HTTP; jiti/virtual-module resolution of `node:http` imports was not executed (herdr proves `node:net`/`node:child_process`, which strongly implies builtins generally work). Needs a smoke test.
3. **QR rendering only verifiable in a live TTY.** `ctx.ui.custom()` API and multi-line `render()` are documented and example-backed, but actual QR block-glyph output width/unicode handling under various terminals is untested (docs require each line to fit `width` and to measure visible columns).
4. **RPC readiness has no explicit signal.** Chosen probe (`get_state` round-trip) is inferred from the docs' framing rules, not from a documented readiness record. A fast-completing startup failure surfaces only as process exit + stderr.
5. **`session_shutdown` not emitted on hard kill.** Registry must handle SIGKILL/crash (connection loss) as implicit session end; verified only that graceful paths emit the event (`interactive-mode.js:3535-3545`).
6. **`hasUI` semantics for a headless sandboxed RPC session**: RPC mode sets up the forwarding UI context, so `ctx.hasUI` is true, but dialogs go to the RPC client — for pi-remote's own headless launches no client will answer `extension_ui_request` records unless the bridge implements `$DOCS/rpc-extension-ui.md`; default dialog values/timeouts then apply (untested).
7. **Sandbox interaction.** `systemd-run` wrapping of spawned `pi --mode rpc` is external to pi (pi documents Docker/Gondolin only, `$DOCS/containerization.md`); interaction of a systemd transient unit's writable paths with pi's session dir (`~/.pi/agent/sessions/`) and jiti cache must be validated on this machine.
8. **Steering-mode nuance.** `steer` delivery with `set_steering_mode "one-at-a-time"` (default) means multiple queued phone messages are released one per completed turn; a bridge that expects immediate delivery must read `queue_update` and reflect the queue (`$DOCS/rpc-commands.md`, `$DOCS/json.md`).
9. **Custom-message steering default.** `pi.sendMessage()` while streaming **steers by default** (`agent-session.js:1988-1995`) — a bridge using `sendMessage` for notes may unintentionally interrupt the model; use `triggerTurn:false` or `deliverAs` explicitly.
