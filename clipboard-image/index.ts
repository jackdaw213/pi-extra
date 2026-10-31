// pi-image — clipboard image paste for pi (TEXT-ONLY widget)
//
// Replaces pi-image-tools for this machine. Linux (Wayland first, X11 fallback).
// Rendering strategy:
//   - Queue-time normalization: every image becomes PNG via ImageMagick (magick).
//   - Transcript rendering: pi core renders attached images when
//     terminal.images is "kitty" (set in ~/.pi/agent/settings.json).
//   - Draft widget: ONE text line above the editor showing the queued COUNT.
//     No kitty images are drawn for the widget. The former kitty thumbnail
//     strip (and its alt+N / click preview overlay) was REMOVED on user
//     request after live testing on Konsole 26.08.2: kitty images anchored in
//     a fixed band above the editor drift upward when the user scrolls (the
//     terminal scrolls the anchored image with scrollback while pi keeps the
//     band fixed), and the line diff ghosts/duplicates lines around the image
//     rows. Text in pi is reliable; kitty images in that band are not.
//     RESEARCH.md holds the evidence.
//   - Keyboard surface (the whole surface — the /paste-image and /watch
//     commands were removed on user decision, 2026-10-31):
//     ctrl+shift+v / ctrl+v / alt+v run one identical SMART PASTE: a
//     clipboard image is queued, otherwise clipboard text is inserted
//     verbatim via ctx.ui.pasteToEditor, otherwise one "clipboard is empty"
//     notify. Extension shortcuts are evaluated before pi's built-in editor
//     handling (verified in pi 1.4.0 custom-editor.js), so these
//     registrations shadow the built-in app.clipboard.pasteImage default
//     (ctrl+v on Linux) WITHOUT any keybindings.json — that file is
//     intentionally absent since 2026-10-31 (hardware COPY/PASTE keys are
//     handled by Konsole action bindings + the Konsole keytab + these
//     shortcuts). alt+x drops the most recently queued one.
//     ENTER ON AN EMPTY EDITOR sends the queued images (2026-10-31): pi's
//     submit gate (`text = text.trim(); if (!text) return;` in
//     interactive-mode.js setupEditorSubmitHandler) makes a bare Enter a
//     no-op, so a screenshot could never be sent alone. The extension
//     replaces the editor via the OFFICIAL ctx.ui.setEditorComponent
//     extension point with a real CustomEditor (pi's own class) whose
//     submitValue is wrapped: empty/whitespace text + non-empty queue →
//     pi.sendUserMessage(queued images); everything else → the original
//     submitValue untouched. Because the editor processes Enter ONLY while
//     it is the focused component, this can never hijack Enter while a core
//     dialog/selector is open (they take focus; see README for why the raw
//     onTerminalInput route was rejected).
//   - Text-paste render poke: pi core's ctx.ui.pasteToEditor inserts text
//     with NO render request (verified in pi 1.4.0), and because the smart
//     paste handler is async, pi's render-on-input has already fired on the
//     unchanged editor by the time the insert lands — the text stays
//     invisible until the next keypress (RESEARCH.md "Part 4"). The smart
//     paste therefore pokes one render immediately after the insert:
//     ctx.ui.setStatus(PASTE_RENDER_STATUS_KEY, undefined) — an unset footer
//     key (invisible), whose setExtensionStatus always calls requestRender.
//     (The former bracketed-paste raw-input watcher is gone: it covered only
//     pi's clean built-in paste path, which needs no help.)

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const execFile = promisify(execFileCb) as (
	cmd: string,
	args: string[],
	options?: { encoding?: BufferEncoding | "buffer"; timeout?: number },
) => Promise<{ stdout: Buffer | string; stderr: Buffer | string }>;

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

interface QueuedImage {
	pngPath: string; // normalized PNG on disk
	label: string; // display name
	base64: string; // PNG bytes, base64
	bytes: number;
}

/** Content shape sent for an image-only message: one text part + the queued images. */
type EditorImageSendContent = [
	{ type: "text"; text: string },
	...{ type: "image"; data: string; mimeType: string }[],
];

const MIME_TO_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
};

const MAX_QUEUE = 10;
const MAX_BYTES = 15 * 1024 * 1024; // per image, pre-encode

const CACHE_DIR = path.join(os.homedir(), ".cache", "pi-image");
const WIDGET_KEY = "pi-image";
/**
 * Sentinel footer status key for the text-paste render poke: never set to a
 * value, so deleting it draws nothing, while pi's setExtensionStatus
 * unconditionally calls requestRender (verified in pi 1.4.0).
 */
const PASTE_RENDER_STATUS_KEY = "pi-image-paste-render";

/**
 * Text part sent with image-only messages. pi builds user messages as
 * `[{ type: "text", text }, ...images]` and the Anthropic adapter forwards
 * text blocks verbatim (it only injects "(see attached image)" when a message
 * has NO text block, which never happens through pi's prompt path), so an
 * image-only send must carry a non-empty text part to keep every provider
 * happy. This string is pi's own placeholder for exactly that situation.
 */
const IMAGE_ONLY_TEXT = "(see attached image)";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let stampCounter = 0;

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	// Counter suffix keeps filenames unique across calls in the same second.
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${++stampCounter}`;
}

function humanBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	if (n >= 1024) return `${Math.round(n / 1024)} KB`;
	return `${n} B`;
}

async function runBuffer(cmd: string, args: string[], timeoutMs = 10_000): Promise<Buffer> {
	const res = await execFile(cmd, args, { encoding: "buffer", timeout: timeoutMs });
	return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout as string);
}

/** Run a UI side effect; a stale runtime or closed TUI must never crash a queue mutation. */
function safely(fn: () => void): void {
	try {
		fn();
	} catch {
		// UI unavailable (stale context after session switch, reload, shutdown).
		// Widget state self-heals on the next updateWidget with a live context.
	}
}

// ---------------------------------------------------------------------------
// Clipboard readers (Wayland first, X11 fallback)
// ---------------------------------------------------------------------------

async function readClipboardImageMime(): Promise<string | undefined> {
	const { stdout } = await execFile("wl-paste", ["--list-types"], { encoding: "buffer", timeout: 5_000 });
	const types = stdout.toString("utf8").split("\n").map((s) => s.trim()).filter(Boolean);
	return types.find((t) => MIME_TO_EXT[t]);
}

async function readClipboardImage(): Promise<{ file: string; mime: string } | { error: string }> {
	const wayland = Boolean(process.env.WAYLAND_DISPLAY);
	const x11 = Boolean(process.env.DISPLAY);

	if (wayland) {
		try {
			const mime = await readClipboardImageMime();
			if (!mime) return { error: "No image found in clipboard" };
			const data = await runBuffer("wl-paste", ["--type", mime]);
			if (data.length === 0) return { error: "Clipboard image is empty" };
			const file = path.join(CACHE_DIR, `clipboard-${stamp()}.${MIME_TO_EXT[mime]}`);
			await fsp.writeFile(file, data);
			return { file, mime };
		} catch (err) {
			if (!x11) return { error: `wl-paste failed: ${err instanceof Error ? err.message : String(err)}` };
			// fall through to X11
		}
	}

	if (x11) {
		for (const mime of Object.keys(MIME_TO_EXT)) {
			try {
				const data = await runBuffer("xclip", ["-selection", "clipboard", "-t", mime, "-o"]);
				if (data.length > 0) {
					const file = path.join(CACHE_DIR, `clipboard-${stamp()}.${MIME_TO_EXT[mime]}`);
					await fsp.writeFile(file, data);
					return { file, mime };
				}
			} catch {
				// try next mime
			}
		}
		return { error: "No image found in clipboard (xclip)" };
	}

	return { error: "No graphical session detected (need WAYLAND_DISPLAY or DISPLAY)" };
}

/**
 * Read the clipboard TEXT payload (Wayland first, X11 fallback). Bytes pass
 * through as-is — no newline trimming; a zero-length payload is "empty".
 */
async function readClipboardText(): Promise<{ text: string } | { error: string }> {
	const wayland = Boolean(process.env.WAYLAND_DISPLAY);
	const x11 = Boolean(process.env.DISPLAY);

	if (wayland) {
		try {
			const data = await runBuffer("wl-paste", ["--type", "text/plain"]);
			if (data.length === 0) return { error: "Clipboard text is empty" };
			return { text: data.toString("utf8") };
		} catch (err) {
			if (!x11) return { error: `wl-paste failed: ${err instanceof Error ? err.message : String(err)}` };
			// fall through to X11
		}
	}

	if (x11) {
		try {
			const data = await runBuffer("xclip", ["-selection", "clipboard", "-t", "text/plain", "-o"]);
			if (data.length === 0) return { error: "Clipboard text is empty" };
			return { text: data.toString("utf8") };
		} catch (err) {
			return { error: `xclip failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	return { error: "No graphical session detected (need WAYLAND_DISPLAY or DISPLAY)" };
}

// ---------------------------------------------------------------------------
// Normalization: anything -> PNG via ImageMagick (option A mechanism)
// ---------------------------------------------------------------------------

async function normalizeToPng(srcFile: string, srcMime: string): Promise<{ pngPath: string } | { error: string }> {
	if (srcMime === "image/png") return { pngPath: srcFile };

	const dst = path.join(CACHE_DIR, `${path.basename(srcFile, path.extname(srcFile))}-${stamp()}.png`);
	try {
		await execFile("magick", [srcFile, dst], { encoding: "buffer", timeout: 30_000 });
	} catch (err) {
		return { error: `magick conversion failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
	}
	const st = await fsp.stat(dst).catch(() => undefined);
	if (!st || st.size === 0) return { error: "magick produced empty output" };
	return { pngPath: dst };
}

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

function createExtension(sendUserMessage: (content: EditorImageSendContent, options?: { deliverAs?: "steer" | "followUp" }) => void) {
	const queue: QueuedImage[] = [];
	let tuiRef: { requestRender(): void } | undefined;
	/** True only after ctx.ui.setWidget() actually registered (or is still holding) the widget. */
	let widgetRegistered = false;
	/** Version string already reflected by the registered widget's caches. */
	let syncedVersion = "";
	/** True while session compaction is running (Enter-send is paused). */
	let compactionRunning = false;

	function contentVersion(): string {
		return queue.map((q) => q.pngPath).join("|");
	}

	// -- Draft widget: one text line ------------------------------------------
	//
	// The widget is registered with pi exactly once per "show" and keeps a
	// single component instance: pi invokes the setWidget factory immediately
	// and replaces the stored component on every call, so re-registering on
	// each queue change would rebuild the component on every paste. Instead
	// the component reads the live queue on every render() and caches its one
	// line by content version and width.
	//
	// There are no Image components, no hit grid, and no raw input listeners:
	// the line is plain text, so unchanged frames are byte-stable by
	// construction and the terminal has no graphics to repaint or retransmit.

	// -- Queue mutation -------------------------------------------------------

	/**
	 * Drop the most recently enqueued image (alt+x). No-op on an empty queue.
	 * Feedback is de-noised: the widget count updating in place is the signal,
	 * so intermediate drops are silent; only a drop that EMPTIES the queue
	 * notifies ("queue empty"), because the widget line disappears with it.
	 * Like the input transform, the queue is mutated FIRST and every UI side
	 * effect is guarded, so a stale or closed UI can never lose the queue
	 * state change.
	 */
	function dropLastFromQueue(ctx: ExtensionContext): void {
		const removed = queue.pop();
		if (!removed) return;
		if (queue.length === 0) {
			safely(() => ctx.ui.notify("[pi-image] queue empty", "info"));
		}
		safely(() => updateWidget(ctx));
	}

	interface WidgetComponent {
		render(width: number): string[];
		invalidate(): void;
		/** Drop the cached line (used when the widget hides). */
		reset(): void;
	}

	/**
	 * Build the single widget line for the current queue at a given width.
	 * Count only — filenames are noise (screenshot names). The fixed text is
	 * far below any realistic editor width, so truncation is a hard tail trim.
	 */
	function widgetLine(width: number): string {
		return truncateToWidth(`[pi-image] ${queue.length} queued · alt+x drops last`, width);
	}

	function createWidgetComponent(): WidgetComponent {
		let cachedVersion = "";
		let localWidth: number | undefined;
		let cachedLines: string[] | undefined;

		return {
			render(width: number): string[] {
				const version = contentVersion();
				if (cachedLines && cachedVersion === version && localWidth === width) return cachedLines;
				cachedVersion = version;
				syncedVersion = version;
				localWidth = width;
				cachedLines = [widgetLine(width)];
				return cachedLines;
			},
			invalidate(): void {
				cachedLines = undefined;
			},
			reset(): void {
				cachedLines = undefined;
				cachedVersion = "";
				localWidth = undefined;
			},
		};
	}

	// Single long-lived widget component while the widget is visible.
	let widgetComp: WidgetComponent | undefined;

	/**
	 * Sync the widget with the queue. Idempotent and unconditional about
	 * clearing: after any queue mutation, an empty queue always hides the
	 * widget (when a UI-capable context is available), and a non-empty queue
	 * always shows an up-to-date one. Never throws — UI failures leave the
	 * flags consistent so the next sync with a live context self-heals.
	 */
	function updateWidget(ctx: ExtensionContext): void {
		// ctx.hasUI/ctx.mode are getters that throw on a stale runtime; treat a
		// throwing context as UI-less so queue state never depends on UI health.
		let uiCapable = false;
		safely(() => {
			uiCapable = ctx.hasUI && ctx.mode === "tui";
		});

		if (queue.length === 0) {
			if (uiCapable && widgetRegistered) {
				let cleared = false;
				safely(() => {
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					cleared = true;
				});
				// Keep the flag true when pi still holds the widget (the clear
				// threw), so the next sync retries instead of double-registering.
				widgetRegistered = !cleared;
			}
			if (!widgetRegistered) {
				// Widget is gone from pi (or never was): drop the cached line so
				// nothing stale can re-appear on the next show.
				widgetComp?.reset();
				widgetComp = undefined;
				syncedVersion = "";
			}
			return;
		}

		if (!uiCapable) return; // cannot show UI; queue state stays authoritative

		if (!widgetRegistered) {
			widgetComp = createWidgetComponent();
			let registered = false;
			safely(() => {
				ctx.ui.setWidget(WIDGET_KEY, (tui) => {
					tuiRef = tui;
					return widgetComp as WidgetComponent;
				});
				registered = true;
			});
			widgetRegistered = registered;
			if (!registered) {
				widgetComp.reset();
				widgetComp = undefined;
				return;
			}
			safely(() => tuiRef?.requestRender());
			return;
		}

		// Already registered: refresh only when the content actually changed.
		if (contentVersion() !== syncedVersion) {
			widgetComp?.invalidate();
			safely(() => tuiRef?.requestRender());
		}
	}

	async function enqueueFromPath(ctx: ExtensionContext, srcFile: string, srcMime: string): Promise<void> {
		if (queue.length >= MAX_QUEUE) {
			safely(() => ctx.ui.notify(`Queue full (${MAX_QUEUE}). Send, or press alt+x to drop the last image.`, "warning"));
			return;
		}
		const st = await fsp.stat(srcFile).catch(() => undefined);
		if (!st?.isFile()) {
			safely(() => ctx.ui.notify(`Not a file: ${srcFile}`, "error"));
			return;
		}
		if (st.size > MAX_BYTES) {
			safely(() =>
				ctx.ui.notify(`Image too large (${humanBytes(st.size)}, limit ${humanBytes(MAX_BYTES)}).`, "error"),
			);
			return;
		}
		const norm = await normalizeToPng(srcFile, srcMime);
		if ("error" in norm) {
			safely(() => ctx.ui.notify(norm.error, "error"));
			return;
		}
		const data = await fsp.readFile(norm.pngPath);
		queue.push({
			pngPath: norm.pngPath,
			label: path.basename(srcFile),
			base64: data.toString("base64"),
			bytes: data.length,
		});
		// No per-paste success notify: the widget count line updating is the
		// feedback. Error paths above still notify.
		updateWidget(ctx);
	}

	/**
	 * Smart paste — the one handler behind ctrl+shift+v / ctrl+v / alt+v:
	 *  1. An image (first offered image mime) is enqueued through the normal
	 *     path. Success is silent (the widget count is the feedback); the
	 *     internal failures of enqueueFromPath (queue full, too large, magick)
	 *     keep their specific notifies. A clipboard that carries an image
	 *     never falls through to text.
	 *  2. Otherwise the text/plain payload is inserted verbatim via
	 *     ctx.ui.pasteToEditor (pi's own paste handling, incl. large-content
	 *     collapse), followed by one render poke: pi's pasteToEditor requests
	 *     no render, and this async handler's first await already let pi's
	 *     render-on-input fire on the unchanged editor. Bytes pass through
	 *     as-is — no newline trimming.
	 *  3. No image and no text → one "[pi-image] clipboard is empty" notify.
	 */
	async function smartPaste(ctx: ExtensionContext): Promise<void> {
		const img = await readClipboardImage();
		if (!("error" in img)) {
			await enqueueFromPath(ctx, img.file, img.mime);
			return;
		}
		const txt = await readClipboardText();
		if (!("error" in txt) && txt.text.length > 0) {
			safely(() => ctx.ui.pasteToEditor(txt.text));
			// The insert alone stays invisible: pasteToEditor requests no render
			// and pi's render-on-input already fired on the unchanged editor
			// (RESEARCH.md Part 4). Poke one render via the invisible sentinel
			// footer key; setExtensionStatus always requestRender()s.
			safely(() => ctx.ui.setStatus(PASTE_RENDER_STATUS_KEY, undefined));
			return;
		}
		safely(() => ctx.ui.notify("[pi-image] clipboard is empty", "info"));
	}

	/** Hide the widget if pi still holds it. */
	function dispose(ctx: ExtensionContext): void {
		if (!widgetRegistered) return;
		safely(() => {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			widgetRegistered = false;
		});
	}

	/**
	 * Send the queued images on an empty-editor Enter (submitValue wrap).
	 *
	 * Guard order (each keeps the queue intact unless the send is actually
	 * attempted):
	 *  1. Empty queue → nothing to do (pi's own empty-submit no-op).
	 *  2. Compaction running → pi's prompt() throws for every send during
	 *     compaction and typed text goes through pi's own compaction queue
	 *     instead; there is no image path for that queue, so pause until the
	 *     compaction events say it is over. Tracked via session_before_compact /
	 *     session_compact / session_compact_failed / agent_settled.
	 *  3. No model → pi's prompt() would throw; notify and keep the queue.
	 *  4. Streaming → deliverAs "steer": pi's own queue for mid-run messages,
	 *     the exact path the editor's typed-text steer uses (submit mid-run in
	 *     setupEditorSubmitHandler calls session.prompt(text, { streamingBehavior
	 *     : "steer" })). pi renders it in the pending-messages display via its
	 *     queue_update event.
	 *
	 * The queue is mutated FIRST (same ordering as the input transform): the
	 * send dispatches our own "input" event asynchronously, which must see an
	 * empty queue or it would attach the images a second time. pi.sendUserMessage
	 * is fire-and-forget (async failures surface as pi extension errors, exactly
	 * like the existing input-transform exposure when prompt() rejects after the
	 * transform); a SYNCHRONOUS throw means nothing was dispatched, so the queue
	 * is restored and the failure notified.
	 */
	function sendQueuedFromEditor(ctx: ExtensionContext): void {
		if (queue.length === 0) return;

		if (compactionRunning) {
			safely(() => ctx.ui.notify("[pi-image] cannot send while compaction is running — press Enter again after it finishes", "warning"));
			return;
		}

		let streaming = false;
		let hasModel = true;
		safely(() => {
			streaming = !ctx.isIdle();
		});
		safely(() => {
			hasModel = ctx.model !== undefined;
		});
		if (!hasModel) {
			safely(() => ctx.ui.notify("[pi-image] no model selected — queued images kept, press Enter again after selecting one", "error"));
			return;
		}

		const queuedCount = queue.length;
		const taken = queue.splice(0, queue.length);
		const content: EditorImageSendContent = [
			{ type: "text", text: IMAGE_ONLY_TEXT },
			...taken.map((q) => ({ type: "image" as const, data: q.base64, mimeType: "image/png" })),
		];
		try {
			sendUserMessage(content, streaming ? { deliverAs: "steer" } : undefined);
		} catch (err) {
			// Nothing was dispatched: put the images back, in order.
			queue.unshift(...taken);
			safely(() => updateWidget(ctx));
			safely(() =>
				ctx.ui.notify(`[pi-image] send failed: ${err instanceof Error ? err.message : String(err)} — images kept queued`, "error"),
			);
			return;
		}
		// No render poke needed here: the queue clear goes through
		// setWidget(key, undefined) → pi's renderWidgets() → requestRender(),
		// and pi's own send path renders the transcript message.
		safely(() => updateWidget(ctx));
		safely(() => ctx.ui.notify(`[pi-image] sent ${queuedCount} image(s)`, "info"));
	}

	/** Structural view of the TS-private submitValue slot on Editor instances. */
	interface EditorComponentWithSubmit {
		submitValue: () => void;
	}

	/** Same shape as pi's EditorFactory (not re-exported by the 1.4.0 package index). */
	type EditorFactoryFn = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor;

	/**
	 * Editor factory for ctx.ui.setEditorComponent: a REAL CustomEditor (pi's
	 * own class, exported for exactly this purpose — see the modal-editor
	 * example) with ONE instance-level wrap around submitValue. submitValue is
	 * TS-private on Editor, hence the structural cast; the wrap adds only the
	 * empty-editor branch and delegates everything else to the original.
	 * registerEditorComponent installs it once per session_start.
	 */
	function createEditorFactory(ctx: ExtensionContext): EditorFactoryFn {
		return (tui, theme, keybindings) => {
			const editor = new CustomEditor(tui, theme, keybindings);
			const submitAccess = editor as unknown as EditorComponentWithSubmit;
			const originalSubmit = submitAccess.submitValue.bind(editor);
			submitAccess.submitValue = () => {
				let text: string;
				try {
					text = (editor.getExpandedText?.() ?? editor.getText()).trim();
				} catch {
					originalSubmit();
					return;
				}
				if (text !== "") {
					// Normal submit — pi's own path, untouched (slash commands, bash
					// mode, steering of typed text, the empty-text gate upstream).
					originalSubmit();
					return;
				}
				sendQueuedFromEditor(ctx);
			};
			return editor;
		};
	}

	/**
	 * Register the wrapped editor against a live TUI-capable context.
	 * Re-registering on every session_start is what pi's own modal-editor
	 * example does; setCustomEditorComponent preserves the current editor text
	 * and re-wires onSubmit/onChange/actions onto the new instance.
	 */
	function registerEditorComponent(ctx: ExtensionContext): void {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		safely(() => {
			ctx.ui.setEditorComponent(createEditorFactory(ctx));
		});
	}

	function setCompactionRunning(running: boolean): void {
		compactionRunning = running;
	}

	return {
		queue,
		updateWidget,
		enqueueFromPath,
		smartPaste,
		dropLastFromQueue,
		dispose,
		registerEditorComponent,
		setCompactionRunning,
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const state = createExtension((content, options) => pi.sendUserMessage(content, options));
	const { queue } = state;

	fs.mkdirSync(CACHE_DIR, { recursive: true });

	// One identical smart-paste handler behind all three keys. Extension
	// shortcuts are evaluated before built-in editor handling (verified in
	// pi 1.4.0 custom-editor.js), so these registrations fully own the paste
	// keys and shadow the built-in app.clipboard.pasteImage default (ctrl+v on
	// Linux) with no keybindings.json involved — that file is intentionally
	// absent. Without this ownership ctrl+shift+v would reach pi's builtin,
	// which on Linux inserts the image's file PATH as text instead of
	// attaching it.
	const pasteDescription = "pi-image: smart paste — clipboard image queues, clipboard text inserts";
	const pasteHandler = (ctx: ExtensionContext) => state.smartPaste(ctx);

	pi.registerShortcut("ctrl+shift+v", {
		description: pasteDescription,
		handler: pasteHandler,
	});
	pi.registerShortcut("ctrl+v", {
		description: pasteDescription,
		handler: pasteHandler,
	});
	pi.registerShortcut("alt+v", {
		description: pasteDescription,
		handler: pasteHandler,
	});
	// Not bound by any pi default action (verified against pi's keybindings),
	// so registration owns it the same way alt+v does.
	pi.registerShortcut("alt+x", {
		description: "pi-image: drop the last queued image",
		// The drop itself is sync and self-guarded; nothing to await.
		handler: (ctx) => {
			state.dropLastFromQueue(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Fresh session: drop any queue from the previous runtime before the
		// first widget sync. Stale `pi-image-previews` session entries from
		// older builds are simply never read.
		queue.length = 0;
		state.setCompactionRunning(false);
		// (Re-)bind the empty-Enter editor: a real CustomEditor whose submitValue
		// sends the queued images when the editor is empty/whitespace. pi's own
		// modal-editor example registers here too; setCustomEditorComponent
		// preserves editor text and re-wires the mode's handlers. No-op outside
		// TUI mode (pi's non-TUI UI contexts stub it out anyway).
		state.registerEditorComponent(ctx);
		state.updateWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// The runtime is going away: hide the widget defensively. pi also clears
		// extension widgets when rebinding, so this is belt-and-braces.
		state.dispose(ctx);
	});

	// Compaction pauses the empty-Enter send: pi's prompt() throws for every
	// send while compaction is in progress, and typed text is routed through
	// pi's own compaction queue instead — a queue that carries no images. The
	// flag resets on the outcome events, on agent_settled (covers a cancelled
	// compaction, which emits neither outcome), and on session_start.
	pi.on("session_before_compact", () => {
		state.setCompactionRunning(true);
	});
	pi.on("session_compact", () => {
		state.setCompactionRunning(false);
	});
	pi.on("session_compact_failed", () => {
		state.setCompactionRunning(false);
	});
	pi.on("agent_settled", () => {
		state.setCompactionRunning(false);
	});

	pi.on("input", async (event, ctx) => {
		if (queue.length === 0) return { action: "continue" };
		const queuedCount = queue.length;
		// A transform result replaces event.images entirely, so keep native attachments.
		const images = [
			...(event.images ?? []),
			...queue.map((q) => ({ type: "image" as const, data: q.base64, mimeType: "image/png" })),
		];
		// Mutate the queue FIRST, then do side effects guarded: pi swallows
		// extension handler errors, and a throw here would silently drop the
		// transform (message sent without the queued images) or leave a stale
		// widget line showing files that are no longer queued.
		queue.length = 0;
		try {
			state.updateWidget(ctx);
		} catch {
			// widget sync must never cost us the transform
		}
		try {
			ctx.ui.notify(`[pi-image] attached ${queuedCount} queued image(s)`, "info");
		} catch {
			// notification is best-effort
		}
		return { action: "transform", text: event.text, images };
	});
}
