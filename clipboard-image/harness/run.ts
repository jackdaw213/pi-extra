// Headless harness for the pi-image extension. Loads index.ts through jiti
// with @earendil-works/pi-tui aliased to a deterministic mock, drives the
// extension through a mock ExtensionAPI/ExtensionContext that mirrors pi
// 1.4.0 interactive-mode semantics, and asserts lifecycle, text-widget
// content, alt+x invariants, and the text-paste render poke.
// Run: npx jiti harness/run.ts
//
// The extension surface is keys only (no slash commands): enqueues go through
// the ctrl+v shortcut against a wl-paste stub whose payload file
// ($PIH_PNG) is swapped per call, so every enqueue produces a unique
// clipboard-<stamp>.png label while still exercising the real clipboard path.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const worktree = path.resolve(typeof __dirname !== "undefined" ? __dirname : ".", "..");

// Hermetic HOME before index.ts computes CACHE_DIR from os.homedir().
const harnessHome = path.join(os.tmpdir(), "pi-image-harness-home");
fs.rmSync(harnessHome, { recursive: true, force: true });
fs.mkdirSync(harnessHome, { recursive: true });
process.env.HOME = harnessHome;
process.env.WAYLAND_DISPLAY = "wayland-0";

// wl-paste stub so the clipboard path runs headlessly:
//   --list-types prints $PIH_TYPES (default "image/png"; the sentinel
//   "none" prints nothing = empty clipboard) and type reads follow
//   $PIH_MODE (default "image" = cat $PIH_PNG): "text" prints $PIH_TEXT
//   verbatim, "empty" prints zero bytes, "fail" exits 1.
const stubDir = path.join(os.tmpdir(), "pi-image-harness-bin");
fs.mkdirSync(stubDir, { recursive: true });
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
fs.writeFileSync(
	path.join(stubDir, "wl-paste"),
	[
		"#!/bin/sh",
		'case "$1" in',
		"  --list-types)",
		'    case "$PIH_TYPES" in',
		'      "") printf \'image/png\\n\' ;;',
		"      none) : ;;",
		'      *) printf \'%s\\n\' "$PIH_TYPES" ;;',
		"    esac",
		"    ;;",
		"  *)",
		'    case "${PIH_MODE:-image}" in',
		'      image) cat "$PIH_PNG" ;;',
		'      text) printf \'%s\' "$PIH_TEXT" ;;',
		"      empty) : ;;",
		'      fail) echo "pi-image-harness: stub failure" >&2; exit 1 ;;',
		"    esac",
		"    ;;",
		"esac\n",
	].join("\n"),
	{ mode: 0o755 },
);
process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;

async function main(): Promise<void> {
	const { visibleWidth } = await import("./mock-tui.ts");
	const { createPiMock, createUiMock, createContextMock, settle, tuiMock, themeMock } = await import("./mock-pi.ts");

	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-tui": path.join(worktree, "harness", "mock-tui.ts"),
			// index.ts imports CustomEditor at runtime; keep the real pi runtime
			// graph out of the harness and use the faithful mock instead.
			"@earendil-works/pi-coding-agent": path.join(worktree, "harness", "mock-coding-agent.ts"),
		},
	});
	const extension = (await jiti.import(path.join(worktree, "index.ts"))) as {
		default: (pi: unknown) => void;
	};

	// -- tiny test framework ----------------------------------------------------

	let pass = 0;
	const failures: string[] = [];

	function check(name: string, cond: boolean, detail?: string): void {
		if (cond) {
			pass++;
			console.log(`  ok  ${name}`);
		} else {
			failures.push(detail ? `${name} :: ${detail}` : name);
			console.log(`FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
		}
	}

	// -- per-test setup ----------------------------------------------------------

	interface WidgetComp {
		render(width: number): string[];
	}

	interface Rig {
		pi: ReturnType<typeof createPiMock>;
		ui: ReturnType<typeof createUiMock>;
		ctx: ReturnType<typeof createContextMock>;
		shortcut: (id: string) => Promise<void>;
		fireInput: (event: {
			text: string;
			images?: { type: "image"; data: string; mimeType: string }[];
		}) => Promise<unknown>;
		sessionStart: () => Promise<void>;
		widget: () => WidgetComp | undefined;
		widgetLines: (width?: number) => string[];
		fireInputWith: (ctxOverride: unknown, event: { text: string; images?: { type: "image"; data: string; mimeType: string }[] }) => Promise<unknown>;
	}

	// Monotonic counters: unique payload files for the whole run.
	let pngSeq = 0;

	function setup(): Rig {
		const pi = createPiMock();
		extension.default(pi);
		const ui = createUiMock();
		const ctx = createContextMock(pi, ui);
		return {
			pi,
			ui,
			ctx,
			async shortcut(id: string) {
				await pi.shortcuts.get(id)!.handler(ctx);
			},
			async fireInput(event) {
				const handler = pi.handlers.get("input")?.[0];
				if (!handler) throw new Error("no input handler registered");
				return await handler({ type: "input", source: "interactive", ...event }, ctx);
			},
			async fireInputWith(ctxOverride, event) {
				const handler = pi.handlers.get("input")?.[0];
				if (!handler) throw new Error("no input handler registered");
				return await handler({ type: "input", source: "interactive", ...event }, ctxOverride as never);
			},
			async sessionStart() {
				for (const h of pi.handlers.get("session_start") ?? []) {
					await h({ type: "session_start", reason: "startup" }, ctx);
				}
			},
			widget() {
				return ui.widgets.get("pi-image") as WidgetComp | undefined;
			},
			// Wide by default so the full line renders untruncated; narrow-width
			// tests pass an explicit width.
			widgetLines(width = 400) {
				const comp = ui.widgets.get("pi-image") as WidgetComp | undefined;
				return comp ? comp.render(width) : [];
			},
		};
	}

	/**
	 * Enqueue one image through the real ctrl+v clipboard path: swap the
	 * wl-paste stub's payload to a fresh file, fire the shortcut, and return
	 * the queued label taken from the new cache file the clipboard reader
	 * wrote. A successful enqueue is silent by design (the widget count line
	 * is the feedback), so this also fails loudly if any notify appears.
	 */
	async function enqueueClipboard(rig: Rig): Promise<string> {
		const payload = path.join(os.tmpdir(), `pi-image-harness-payload-${++pngSeq}.png`);
		fs.writeFileSync(payload, TINY_PNG);
		process.env.PIH_PNG = payload;
		// Force the image branch explicitly: earlier test groups may have left
		// PIH_MODE=text/empty behind.
		process.env.PIH_MODE = "image";
		const cacheDir = path.join(harnessHome, ".cache", "pi-image");
		const filesBefore = new Set(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []);
		const notifiesBefore = rig.ui.notifies.length;
		await rig.shortcut("ctrl+v");
		const newFiles = fs.readdirSync(cacheDir).filter((f) => !filesBefore.has(f));
		if (newFiles.length !== 1) {
			throw new Error(`ctrl+v wrote ${newFiles.length} cache files, expected exactly 1`);
		}
		const newNotifies = rig.ui.notifies.slice(notifiesBefore);
		if (newNotifies.length > 0) {
			throw new Error(`enqueue produced unexpected notify(s): ${newNotifies.map((n) => n.message).join(" | ")}`);
		}
		return newFiles[0]!;
	}

	/** The first (only) widget line at a width, as plain text. */
	function line(width = 400): string {
		const lines = rig.widgetLines(width);
		return lines.length === 1 ? (lines[0] ?? "") : `<${lines.length} lines>`;
	}

	interface MockEditor {
		handleInput(data: string): void;
		getText(): string;
		getExpandedText(): string;
		setText(text: string): void;
		onSubmit?: (text: string) => void;
		onChange?: (text: string) => void;
	}

	/** Build the editor the extension registered on the last session_start. */
	function editor(rig: Rig): MockEditor {
		const factory = rig.ui.editorFactories.at(-1);
		if (!factory) throw new Error("no editor factory registered");
		return factory(tuiMock, themeMock, {}) as MockEditor;
	}

	const MODEL = { id: "test-model", provider: "test" } as never;

	function fireSessionEvent(rig: Rig, type: string, event: Record<string, unknown> = {}): Promise<void> {
		return Promise.all(
			(rig.pi.handlers.get(type) ?? []).map((h) => h({ type, ...event }, rig.ctx as never) as unknown as Promise<void>),
		).then(() => undefined);
	}

	// -- tests -------------------------------------------------------------------

	let rig!: Rig;

	console.log("== T1: enqueue 3 → input transform → widget hidden, images merged, no re-registration ==");
	{
		rig = setup();
		await rig.sessionStart();
		check("no widget before first enqueue", !rig.ui.widgets.has("pi-image"));
		for (let i = 0; i < 3; i++) await enqueueClipboard(rig);
		check("widget visible after enqueues", rig.ui.widgets.has("pi-image"));
		check("widget registered exactly once", rig.ui.registrations === 1, `registrations=${rig.ui.registrations}`);
		const expected = "[pi-image] 3 queued · alt+x drops last";
		const lines = rig.widgetLines();
		check("widget is one text line", lines.length === 1, `lines=${lines.length}`);
		check("line is the exact expected text", lines[0] === expected, lines[0]);
		check("line has no escape/kitty sequences", !lines[0]!.includes("\x1b"));
		check("extension registers no commands (paste-image/watch removed)", rig.pi.commands.size === 0, `commands=${[...rig.pi.commands.keys()].join(",")}`);

		const result = (await rig.fireInput({
			text: "hello",
			images: [{ type: "image", data: "QUFB", mimeType: "image/png" }],
		})) as { action: string; text: string; images?: { type: string }[] };
		check("transform action", result.action === "transform");
		check("text preserved", result.text === "hello");
		check("images merged (1 native + 3 queued)", result.images?.length === 4, `len=${result.images?.length}`);
		check("widget hidden after send", !rig.ui.widgets.has("pi-image"));
		check("attach notify shown", rig.ui.notifies.some((n) => n.message.includes("attached 3")));
		check("no re-registration during whole flow", rig.ui.registrations === 1, `registrations=${rig.ui.registrations}`);
	}

	console.log("== T2: status line is count-only — exact text, singular, no filenames, byte-stable ==");
	{
		rig = setup();
		await rig.sessionStart();
		check("hidden when queue is empty", !rig.ui.widgets.has("pi-image"));
		check("no lines when hidden", rig.widgetLines().length === 0);
		const label1 = await enqueueClipboard(rig);
		const comp = rig.widget()!;
		const a = comp.render(200);
		const b = comp.render(200);
		check("repeat render returns the identical cached array (byte-stable)", a === b);
		check("one line at wide width", a.length === 1);
		check("singular exact line for 1 queued", a[0] === "[pi-image] 1 queued · alt+x drops last", a[0]);
		check("no filenames in the line", !(a[0] ?? "").includes(".png") && !(a[0] ?? "").includes(label1), a[0]);
		check("line fits its width", visibleWidth(a[0] ?? "") <= 200);
		await enqueueClipboard(rig);
		const c = comp.render(200);
		check("same component instance across enqueues (no rebuild)", rig.widget() === comp);
		check("plural exact line for 2 queued", c[0] === "[pi-image] 2 queued · alt+x drops last", c[0]);
		check("single registration across content changes", rig.ui.registrations === 1, `registrations=${rig.ui.registrations}`);
	}

	console.log("== T3: narrow width — count line hard-truncates, stays one line ==");
	{
		rig = setup();
		await rig.sessionStart();
		for (let i = 0; i < 3; i++) await enqueueClipboard(rig);
		const wide = line(400);
		check("wide render is the exact full line", wide === "[pi-image] 3 queued · alt+x drops last", wide);
		check("wide render fits", visibleWidth(wide) <= 400);

		const narrow = line(40);
		check("narrow render fits width", visibleWidth(narrow) <= 40, narrow);
		check("narrow render keeps the prefix + count", narrow.startsWith("[pi-image] 3 queued"), narrow);
		check("narrow render is one line", rig.widgetLines(40).length === 1);

		const tiny = line(12);
		check("tiny render fits width", visibleWidth(tiny) <= 12, tiny);
		check("tiny render is one line", rig.widgetLines(12).length === 1);
		check("no re-registration across width changes", rig.ui.registrations === 1);
	}

	console.log("== T4: rapid clipboard enqueues → unique files, count reflects them ==");
	{
		rig = setup();
		await rig.sessionStart();
		const cacheDir = path.join(harnessHome, ".cache", "pi-image");
		// Earlier tests also enqueue via the clipboard path; count only this test's delta.
		const beforeFiles = new Set(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []);
		const labels = [await enqueueClipboard(rig), await enqueueClipboard(rig), await enqueueClipboard(rig)];
		check("3 clipboard enqueues", labels.every((l) => l.startsWith("clipboard-")), labels.join(","));
		check("unique clipboard filenames", new Set(labels).size === 3, labels.join(","));
		const afterFiles = fs.readdirSync(cacheDir);
		const delta = afterFiles.filter((f) => !beforeFiles.has(f));
		check("3 unique new files in cache", delta.length === 3 && new Set(delta).size === 3, delta.join(","));
		check("widget visible", rig.ui.widgets.has("pi-image"));
		check("line counts 3 queued", line().includes("[pi-image] 3 queued"), line());
	}

	console.log("== T5: notify failing → transform survives, widget still clears ==");
	{
		rig = setup();
		await rig.sessionStart();
		await enqueueClipboard(rig);
		rig.ui.failNotify = true;
		let threw = false;
		let result: { action?: string; images?: unknown[] } | undefined;
		try {
			result = (await rig.fireInput({
				text: "go",
				images: [{ type: "image", data: "QkxB", mimeType: "image/png" }],
			})) as { action?: string; images?: unknown[] };
		} catch {
			threw = true;
		}
		check("no exception escapes", !threw);
		check("transform returned despite notify failure", result?.action === "transform");
		check("images present despite notify failure", result?.images?.length === 2, `len=${result?.images?.length}`);
		check("widget cleared despite notify failure", !rig.ui.widgets.has("pi-image"));
		rig.ui.failNotify = false;
	}

	console.log("== T6: setWidget failing → no crash; recovers on next enqueue ==");
	{
		rig = setup();
		await rig.sessionStart();
		rig.ui.failSetWidget = true;
		let threw = false;
		try {
			await enqueueClipboard(rig);
		} catch {
			threw = true;
		}
		check("enqueue survives setWidget failure", !threw);
		check("no widget registered on failure", !rig.ui.widgets.has("pi-image"));
		check("no phantom registration count", rig.ui.registrations === 0);
		rig.ui.failSetWidget = false;
		await enqueueClipboard(rig);
		check("widget registers after failure clears", rig.ui.widgets.has("pi-image"));
		check("line counts both files after recovery", line().includes("2 queued"), line());
		check("registered exactly once after recovery", rig.ui.registrations === 1);
	}

	console.log("== T7: stale pi-image-previews session entries ignored ==");
	{
		rig = setup();
		// Entries persisted by older builds must be ignored gracefully.
		rig.pi.branchEntries.push(
			{ type: "custom", customType: "pi-image-previews", data: { enabled: false } },
			{ type: "custom", customType: "pi-image-previews", data: { enabled: true } },
		);
		await rig.sessionStart();
		await enqueueClipboard(rig);
		check("stale previews entries ignored (widget shows normally)", rig.widgetLines().length === 1);
		check("line is the standard count-only line", line().includes("[pi-image] 1 queued"), line());
		check("no previews persistence entries appended", !rig.pi.appendedEntries.some((e) => e.type === "pi-image-previews"));
	}

	console.log("== T8: byte-stability across queue changes; alt+x drop updates line in place ==");
	{
		rig = setup();
		await rig.sessionStart();
		await enqueueClipboard(rig);
		await enqueueClipboard(rig);
		await enqueueClipboard(rig);
		const comp = rig.widget()!;
		check("same component instance across enqueues", rig.widget() === comp);
		check("no re-registration", rig.ui.registrations === 1);
		const line3 = line();
		await enqueueClipboard(rig);
		const line4 = line();
		check("line updates with new content", line4 !== line3 && line4.includes("4 queued"), line4);
		await rig.shortcut("alt+x");
		const afterDrop = line();
		check("drop updates the line in place", afterDrop.includes("3 queued") && afterDrop !== line4, afterDrop);
		check("repeat render after change is byte-stable", rig.widgetLines() === rig.widgetLines());
		check("widget visible after drop", rig.ui.widgets.has("pi-image"));
	}

	console.log("== T9: session_start resets queue and hides widget ==");
	{
		rig = setup();
		await rig.sessionStart();
		await enqueueClipboard(rig);
		await enqueueClipboard(rig);
		check("visible before restart", rig.ui.widgets.has("pi-image"));
		await rig.sessionStart();
		check("widget hidden after session_start", !rig.ui.widgets.has("pi-image"));
		const result = (await rig.fireInput({ text: "hi" })) as { action: string };
		check("input continues with empty queue", result.action === "continue");
		await enqueueClipboard(rig);
		check("fresh enqueue works after restart", rig.ui.widgets.has("pi-image"));
		check("line counts only the fresh file", line().includes("1 queued"), line());
		check("one registration per show (2 total)", rig.ui.registrations === 2, `registrations=${rig.ui.registrations}`);
	}

	console.log("== T10: queue full at 10 ==");
	{
		rig = setup();
		await rig.sessionStart();
		for (let i = 0; i < 10; i++) await enqueueClipboard(rig);
		const before = rig.ui.notifies.length;
		await rig.shortcut("ctrl+v");
		check("11th enqueue rejected", rig.ui.notifies.slice(before).some((n) => n.message.includes("Queue full")));
		check("11th enqueue names the limit", rig.ui.notifies.slice(before).some((n) => n.message.includes("(10)")));
		check("11th enqueue suggests alt+x", rig.ui.notifies.slice(before).some((n) => n.message.includes("alt+x")));
		check("line counts exactly 10 queued", line().includes("[pi-image] 10 queued"), line());
	}

	console.log("== T11: hide/show cycle — fresh component per show, caches dropped on hide ==");
	{
		rig = setup();
		await rig.sessionStart();
		await enqueueClipboard(rig);
		const comp1 = rig.widget();
		check("registered once for first show", rig.ui.registrations === 1);
		await rig.fireInput({ text: "send" });
		check("hidden after send", !rig.ui.widgets.has("pi-image"));
		await enqueueClipboard(rig);
		const comp2 = rig.widget();
		check("re-shown widget is a fresh component (caches dropped on hide)", comp2 !== undefined && comp2 !== comp1);
		check("registered exactly once per show", rig.ui.registrations === 2, `registrations=${rig.ui.registrations}`);
		check("fresh component renders the current queue", (comp2?.render(200)[0] ?? "").includes("1 queued"));
		await rig.fireInput({ text: "send again" });
		check("hidden again after second send", !rig.ui.widgets.has("pi-image"));
		check("still two registrations total", rig.ui.registrations === 2);
	}

	console.log("== T12: stale context (throwing ctx getters) → transform survives, later sync heals ==");
	{
		rig = setup();
		await rig.sessionStart();
		await enqueueClipboard(rig);
		await enqueueClipboard(rig);
		check("widget visible before stale event", rig.ui.widgets.has("pi-image"));
		const staleCtx = {
			get hasUI(): boolean {
				throw new Error("runtime invalidated");
			},
			get mode(): string {
				throw new Error("runtime invalidated");
			},
			get ui() {
				throw new Error("runtime invalidated");
			},
		};
		let threw = false;
		let result: { action?: string; images?: unknown[] } | undefined;
		try {
			result = (await rig.fireInputWith(staleCtx, { text: "after reload" })) as {
				action?: string;
				images?: unknown[];
			};
		} catch {
			threw = true;
		}
		check("no exception escapes stale ctx", !threw);
		check("transform survives stale ctx", result?.action === "transform");
		check("queued images present despite stale ctx", result?.images?.length === 2, `len=${result?.images?.length}`);
		// A later live session_start (fresh runtime in real pi) must hide the widget.
		await rig.sessionStart();
		check("live session_start clears widget after stale event", !rig.ui.widgets.has("pi-image"));
		await enqueueClipboard(rig);
		check("enqueue after recovery works", rig.ui.widgets.has("pi-image"));
		check("one file counted after recovery", line().includes("1 queued"), line());
	}

	console.log("== T13: alt+x drops the LAST queued image only; silent until the queue empties ==");
	{
		rig = setup();
		await rig.sessionStart();
		for (let i = 0; i < 3; i++) await enqueueClipboard(rig);
		const first = rig.ui.notifies.length;
		await rig.shortcut("alt+x");
		check(
			"drop to 2 is silent (widget count is the feedback)",
			rig.ui.notifies.length === first,
			JSON.stringify(rig.ui.notifies.slice(first).map((n) => n.message)),
		);
		check("line counts 2 after first drop", line().includes("2 queued"), line());
		await rig.shortcut("alt+x");
		check("drop to 1 is silent", rig.ui.notifies.length === first);
		check("singular line after second drop", line() === "[pi-image] 1 queued · alt+x drops last", line());
		await rig.shortcut("alt+x");
		check(
			"emptying drop notifies queue empty exactly once",
			rig.ui.notifies.slice(first).filter((n) => n.message === "[pi-image] queue empty").length === 1,
			JSON.stringify(rig.ui.notifies.slice(first).map((n) => n.message)),
		);
		check("no other notify in the whole drop flow", rig.ui.notifies.slice(first).length === 1);
		check("widget hidden after dropping all", !rig.ui.widgets.has("pi-image"));
		check("no lines after dropping all", rig.widgetLines().length === 0);
		check("single registration across the whole drop flow", rig.ui.registrations === 1, `registrations=${rig.ui.registrations}`);
	}

	console.log("== T14: alt+x on an empty queue is a silent no-op ==");
	{
		rig = setup();
		await rig.sessionStart();
		const before = rig.ui.notifies.length;
		await rig.shortcut("alt+x");
		check("no notify on empty queue", rig.ui.notifies.length === before);
		check("no widget appears", !rig.ui.widgets.has("pi-image"));
		check("no registration attempt", rig.ui.registrations === 0);

		// Also silent after a send emptied the queue.
		await enqueueClipboard(rig);
		await rig.fireInput({ text: "send" });
		const before2 = rig.ui.notifies.length;
		await rig.shortcut("alt+x");
		check("no notify when queue emptied by send", rig.ui.notifies.length === before2);
		check("widget stays hidden", !rig.ui.widgets.has("pi-image"));
	}

	console.log("== T15: ctrl+shift+v / ctrl+v / alt+v registered with one identical smart-paste handler ==");
	{
		rig = setup();
		await rig.sessionStart();
		check("ctrl+shift+v registered", rig.pi.shortcuts.has("ctrl+shift+v"));
		check("ctrl+v registered", rig.pi.shortcuts.has("ctrl+v"));
		check("alt+v registered", rig.pi.shortcuts.has("alt+v"));
		check("alt+x still registered", rig.pi.shortcuts.has("alt+x"));
		const hCsv = rig.pi.shortcuts.get("ctrl+shift+v")!.handler;
		const hCv = rig.pi.shortcuts.get("ctrl+v")!.handler;
		const hAv = rig.pi.shortcuts.get("alt+v")!.handler;
		check("all three paste keys share ONE handler function", hCsv === hCv && hCv === hAv);
		check(
			"paste keys describe the smart-paste surface",
			(rig.pi.shortcuts.get("ctrl+shift+v")!.description ?? "").includes("pi-image"),
			rig.pi.shortcuts.get("ctrl+shift+v")!.description,
		);
	}

	console.log("== T16: text clipboard → pasteToEditor with exact bytes, no enqueue, no notify ==");
	{
		rig = setup();
		await rig.sessionStart();
		process.env.PIH_TYPES = "text/plain";
		process.env.PIH_MODE = "text";
		const text = "hello from the clipboard";
		process.env.PIH_TEXT = text;
		const cacheDir = path.join(harnessHome, ".cache", "pi-image");
		const before = new Set(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []);
		await rig.shortcut("ctrl+shift+v");
		check("pasteToEditor called once with the exact text", rig.ui.pasted.length === 1 && rig.ui.pasted[0] === text, JSON.stringify(rig.ui.pasted));
		const newFiles = fs.readdirSync(cacheDir).filter((f) => !before.has(f));
		check("no cache file written (no enqueue)", newFiles.length === 0, newFiles.join(","));
		check("no widget shown", !rig.ui.widgets.has("pi-image"));
		check("no notify on a successful text paste", rig.ui.notifies.length === 0, JSON.stringify(rig.ui.notifies));
		check("nothing was queued: send is a plain continue", ((await rig.fireInput({ text: "hi" })) as { action: string }).action === "continue");

		// Bytes pass through as-is — trailing newline is preserved verbatim.
		const multi = "line1\nline2\n";
		process.env.PIH_TEXT = multi;
		await rig.shortcut("ctrl+v");
		check("trailing newline preserved verbatim via ctrl+v", rig.ui.pasted.length === 2 && rig.ui.pasted[1] === multi, JSON.stringify(rig.ui.pasted));

		process.env.PIH_TEXT = "via alt+v";
		await rig.shortcut("alt+v");
		check("alt+v pastes text too", rig.ui.pasted.length === 3 && rig.ui.pasted[2] === "via alt+v", JSON.stringify(rig.ui.pasted));

		delete process.env.PIH_TYPES;
		delete process.env.PIH_MODE;
		delete process.env.PIH_TEXT;
	}

	console.log("== T17: clipboard with BOTH image and text → image enqueued, no text paste ==");
	{
		rig = setup();
		await rig.sessionStart();
		process.env.PIH_TYPES = "image/png\ntext/plain";
		const label = await enqueueClipboard(rig);
		check("image enqueued through the normal clipboard path", label.startsWith("clipboard-"), label);
		check("pasteToEditor never called", rig.ui.pasted.length === 0, JSON.stringify(rig.ui.pasted));
		check("widget shows the queued image", line().includes("[pi-image] 1 queued"), line());

		// Image priority is per-press: a text-only clipboard still pastes text
		// while images are queued, and the queue is untouched.
		process.env.PIH_TYPES = "text/plain";
		process.env.PIH_MODE = "text";
		process.env.PIH_TEXT = "mixed next";
		await rig.shortcut("ctrl+shift+v");
		check("text paste works while images are queued", rig.ui.pasted.length === 1 && rig.ui.pasted[0] === "mixed next", JSON.stringify(rig.ui.pasted));
		check("queued image untouched", line().includes("[pi-image] 1 queued"), line());

		delete process.env.PIH_TYPES;
		delete process.env.PIH_MODE;
		delete process.env.PIH_TEXT;
	}

	console.log("== T18: empty clipboard → one 'clipboard is empty' notify, nothing else ==");
	{
		rig = setup();
		await rig.sessionStart();
		process.env.PIH_TYPES = "none";
		process.env.PIH_MODE = "empty"; // type reads yield zero bytes
		await rig.shortcut("ctrl+shift+v");
		check(
			"single empty-clipboard notify",
			rig.ui.notifies.length === 1 && rig.ui.notifies[0]!.message === "[pi-image] clipboard is empty",
			JSON.stringify(rig.ui.notifies),
		);
		check("nothing pasted", rig.ui.pasted.length === 0);
		check("no widget", !rig.ui.widgets.has("pi-image"));
		// Same outcome when the reads hard-fail instead of returning bytes.
		rig.ui.notifies.length = 0;
		process.env.PIH_MODE = "fail";
		await rig.shortcut("ctrl+v");
		check(
			"failing reads still end in the empty notify",
			rig.ui.notifies.length === 1 && rig.ui.notifies[0]!.message === "[pi-image] clipboard is empty",
			JSON.stringify(rig.ui.notifies),
		);
		delete process.env.PIH_TYPES;
		delete process.env.PIH_MODE;
	}

	console.log("== T19: text smart paste pokes ONE render after pasteToEditor; no raw-input listener ==");
	{
		rig = setup();
		await rig.sessionStart();
		check("session_start registers NO raw-input listener (watcher removed)", rig.ui.terminalInputListeners.length === 0, `listeners=${rig.ui.terminalInputListeners.length}`);

		// Text path: the insert is followed by exactly one render poke (pi's
		// pasteToEditor requests no render of its own — RESEARCH.md Part 4).
		process.env.PIH_TYPES = "text/plain";
		process.env.PIH_MODE = "text";
		process.env.PIH_TEXT = "render poke";
		await rig.shortcut("ctrl+shift+v");
		check("pasteToEditor called once with the exact text", rig.ui.pasted.length === 1 && rig.ui.pasted[0] === "render poke", JSON.stringify(rig.ui.pasted));
		check("exactly one render poke after the insert", rig.ui.setStatusCalls.length === 1, JSON.stringify(rig.ui.setStatusCalls));
		check(
			"poke is the sentinel status key with undefined text (invisible)",
			rig.ui.setStatusCalls[0]?.key === "pi-image-paste-render" && rig.ui.setStatusCalls[0]?.text === undefined,
			JSON.stringify(rig.ui.setStatusCalls),
		);

		// The poke is a guarded side effect: a throwing setStatus must not lose
		// or corrupt the paste.
		rig.ui.pasted.length = 0;
		rig.ui.setStatusCalls.length = 0;
		rig.ui.failSetStatus = true;
		process.env.PIH_TEXT = "survives the poke failure";
		await rig.shortcut("ctrl+v");
		rig.ui.failSetStatus = false;
		check("paste survives a throwing setStatus", rig.ui.pasted.length === 1 && rig.ui.pasted[0] === "survives the poke failure", JSON.stringify(rig.ui.pasted));
		check("failed poke recorded no call", rig.ui.setStatusCalls.length === 0, JSON.stringify(rig.ui.setStatusCalls));

		// Image path: no poke — the widget registration path renders.
		rig.ui.setStatusCalls.length = 0;
		delete process.env.PIH_TYPES;
		await enqueueClipboard(rig);
		check("image enqueue does NOT poke the render status", rig.ui.setStatusCalls.length === 0, JSON.stringify(rig.ui.setStatusCalls));
		check("image enqueue shows the widget instead", rig.ui.widgets.has("pi-image"));

		// Empty clipboard: notify only, no poke.
		rig.ui.notifies.length = 0;
		rig.ui.setStatusCalls.length = 0;
		process.env.PIH_TYPES = "none";
		process.env.PIH_MODE = "empty";
		await rig.shortcut("alt+v");
		check("empty-clipboard path does NOT poke", rig.ui.setStatusCalls.length === 0, JSON.stringify(rig.ui.setStatusCalls));
		check(
			"empty-clipboard still notifies",
			rig.ui.notifies.length === 1 && rig.ui.notifies[0]!.message === "[pi-image] clipboard is empty",
			JSON.stringify(rig.ui.notifies),
		);
		delete process.env.PIH_TYPES;
		delete process.env.PIH_MODE;
		delete process.env.PIH_TEXT;

		// session_shutdown: nothing listener-related left to clean up.
		for (const h of rig.pi.handlers.get("session_shutdown") ?? []) {
			await h({ type: "session_shutdown" }, rig.ctx);
		}
		check("session_shutdown leaves no raw-input listener", rig.ui.terminalInputListeners.length === 0, `listeners=${rig.ui.terminalInputListeners.length}`);

		// A restart keeps it that way.
		await rig.sessionStart();
		check("restart registers no raw-input listener either", rig.ui.terminalInputListeners.length === 0, `listeners=${rig.ui.terminalInputListeners.length}`);
	}

	console.log("== T20: empty-editor Enter sends the queued images (exact content, queue cleared, widget hidden) ==");
	{
		rig = setup();
		rig.ctx.model = MODEL;
		await rig.sessionStart();
		const ed = editor(rig);
		let submits = 0;
		ed.onSubmit = () => {
			submits++;
		};
		await enqueueClipboard(rig);
		await enqueueClipboard(rig);
		check("widget visible before empty Enter", rig.ui.widgets.has("pi-image"));
		check("editor starts empty", ed.getText() === "");
		ed.handleInput("\r");
		check("sendUserMessage called exactly once", rig.pi.sentUserMessages.length === 1, `calls=${rig.pi.sentUserMessages.length}`);
		const call = rig.pi.sentUserMessages[0];
		const content = call?.content as { type: string; text?: string; data?: string; mimeType?: string }[];
		check("idle send passes no options", call?.options === undefined, JSON.stringify(call?.options));
		check("content is text part + 2 images", Array.isArray(content) && content.length === 3, JSON.stringify(content?.length));
		check("text part is the image-only placeholder", content[0]?.type === "text" && content[0]?.text === "(see attached image)", JSON.stringify(content[0]));
		check(
			"image parts are exact PNG ImageContent",
			content[1]?.type === "image" &&
				content[1]?.data === TINY_PNG.toString("base64") &&
				content[1]?.mimeType === "image/png" &&
				content[2]?.type === "image" &&
				content[2]?.data === TINY_PNG.toString("base64") &&
				content[2]?.mimeType === "image/png",
		);
		check("editor onSubmit never fired (empty branch intercepted)", submits === 0);
		check("queue cleared (widget hidden)", !rig.ui.widgets.has("pi-image"));
		check("empty-Enter send does NOT poke the render status (pi's own send path renders)", rig.ui.setStatusCalls.length === 0, JSON.stringify(rig.ui.setStatusCalls));
		check("no widget lines", rig.widgetLines().length === 0);
		check(
			"send notify shown",
			rig.ui.notifies.some((n) => n.message === "[pi-image] sent 2 image(s)" && n.type === "info"),
			JSON.stringify(rig.ui.notifies),
		);
		check("editor text still empty after empty Enter", ed.getText() === "");
	}

	console.log("== T21: non-empty editor → normal submit path untouched (no sendUserMessage) ==");
	{
		rig = setup();
		rig.ctx.model = MODEL;
		await rig.sessionStart();
		await enqueueClipboard(rig);
		const ed = editor(rig);
		const submitted: string[] = [];
		ed.onSubmit = (text) => {
			submitted.push(text);
		};
		ed.setText("hello");
		ed.handleInput("\r");
		check("no sendUserMessage for a typed submit", rig.pi.sentUserMessages.length === 0);
		check("editor onSubmit fired with the trimmed text", submitted.length === 1 && submitted[0] === "hello", JSON.stringify(submitted));
		check("editor reset after normal submit", ed.getText() === "");
		check("queue untouched (widget still visible)", rig.ui.widgets.has("pi-image"));
		check("widget still counts 1 queued", line().includes("[pi-image] 1 queued"), line());
		check("no notifies from the normal path", rig.ui.notifies.length === 0, JSON.stringify(rig.ui.notifies));

		// Enter with whitespace-only text behaves like the empty branch: pi's
		// own gate would drop it, so our wrap treats it as empty → sends the queue.
		ed.setText("   ");
		ed.handleInput("\r");
		check("whitespace-only editor sends the queue", rig.pi.sentUserMessages.length === 1);
		check("whitespace send carries the queued image", (rig.pi.sentUserMessages[0]?.content as unknown[]).length === 2);
		check("queue cleared after whitespace send", !rig.ui.widgets.has("pi-image"));
	}

	console.log("== T22: queue empty + empty editor → Enter is a silent no-op ==");
	{
		rig = setup();
		rig.ctx.model = MODEL;
		await rig.sessionStart();
		const ed = editor(rig);
		ed.handleInput("\r");
		check("no sendUserMessage on empty everything", rig.pi.sentUserMessages.length === 0);
		check("no notify on empty everything", rig.ui.notifies.length === 0, JSON.stringify(rig.ui.notifies));
		check("no widget", !rig.ui.widgets.has("pi-image"));
	}

	console.log("== T23: streaming agent → empty-editor Enter steers via pi's own queue ==");
	{
		rig = setup();
		rig.ctx.model = MODEL;
		rig.ctx.isIdle = () => false;
		await rig.sessionStart();
		await enqueueClipboard(rig);
		const ed = editor(rig);
		ed.handleInput("\r");
		check("sendUserMessage called while streaming", rig.pi.sentUserMessages.length === 1);
		check(
			"streaming send uses deliverAs steer",
			rig.pi.sentUserMessages[0]?.options?.deliverAs === "steer",
			JSON.stringify(rig.pi.sentUserMessages[0]?.options),
		);
		check("queue cleared after steer", !rig.ui.widgets.has("pi-image"));
	}

	console.log("== T24: compaction running → send paused, queue kept; resumes after session_compact ==");
	{
		rig = setup();
		rig.ctx.model = MODEL;
		await rig.sessionStart();
		await enqueueClipboard(rig);
		const ed = editor(rig);
		await fireSessionEvent(rig, "session_before_compact");
		ed.handleInput("\r");
		check("no send during compaction", rig.pi.sentUserMessages.length === 0);
		check(
			"compaction pause notifies warning",
			rig.ui.notifies.some((n) => n.message.includes("compaction") && n.type === "warning"),
			JSON.stringify(rig.ui.notifies),
		);
		check("queue kept during compaction", rig.ui.widgets.has("pi-image") && line().includes("[pi-image] 1 queued"), line());
		await fireSessionEvent(rig, "session_compact");
		ed.handleInput("\r");
		check("send resumes after compaction ends", rig.pi.sentUserMessages.length === 1);
		check("queue cleared after resumed send", !rig.ui.widgets.has("pi-image"));

		// agent_settled also clears the flag (covers a CANCELLED compaction,
		// which emits neither outcome event).
		await enqueueClipboard(rig);
		await fireSessionEvent(rig, "session_before_compact");
		ed.handleInput("\r");
		check("still paused on a second compaction", rig.pi.sentUserMessages.length === 1);
		await fireSessionEvent(rig, "agent_settled");
		ed.handleInput("\r");
		check("agent_settled clears the pause (send goes through)", rig.pi.sentUserMessages.length === 2);
	}

	console.log("== T25: no model selected → error notify, queue kept ==");
	{
		rig = setup();
		await rig.sessionStart();
		await enqueueClipboard(rig);
		const ed = editor(rig);
		ed.handleInput("\r");
		check("no send without a model", rig.pi.sentUserMessages.length === 0);
		check(
			"no-model notifies error",
			rig.ui.notifies.some((n) => n.message.includes("no model selected") && n.type === "error"),
			JSON.stringify(rig.ui.notifies),
		);
		check("queue kept without a model", rig.ui.widgets.has("pi-image") && line().includes("[pi-image] 1 queued"), line());
	}

	console.log("== T26: synchronous send failure → queue restored, error notified ==");
	{
		rig = setup();
		rig.ctx.model = MODEL;
		await rig.sessionStart();
		await enqueueClipboard(rig);
		rig.pi.failSendUserMessage = true;
		const ed = editor(rig);
		let threw = false;
		try {
			ed.handleInput("\r");
		} catch {
			threw = true;
		}
		check("no exception escapes the editor", !threw);
		check("failed send recorded nothing", rig.pi.sentUserMessages.length === 0);
		check("queue restored after failed send", rig.ui.widgets.has("pi-image") && line().includes("[pi-image] 1 queued"), line());
		check(
			"send failure notifies error",
			rig.ui.notifies.some((n) => n.message.includes("send failed") && n.type === "error"),
			JSON.stringify(rig.ui.notifies),
		);
		rig.pi.failSendUserMessage = false;
		ed.handleInput("\r");
		check("retry after failure succeeds", rig.pi.sentUserMessages.length === 1);
		check("queue cleared after retry", !rig.ui.widgets.has("pi-image"));
	}

	console.log("== T27: editor registered once per session_start; factory yields working editors ==");
	{
		rig = setup();
		await rig.sessionStart();
		check("session_start registers one editor factory", rig.ui.editorFactories.length === 1, `factories=${rig.ui.editorFactories.length}`);
		check("getEditorComponent returns it", rig.ui.editorFactories.at(-1) === (rig.ctx.ui as unknown as { getEditorComponent(): unknown }).getEditorComponent());
		const ed1 = editor(rig);
		check("factory builds an editor with the submit surface", typeof ed1.handleInput === "function" && typeof ed1.getText === "function");
		await rig.sessionStart();
		check("repeated session_start re-registers (fresh factory)", rig.ui.editorFactories.length === 2, `factories=${rig.ui.editorFactories.length}`);
		const ed2 = editor(rig);
		check("fresh factory builds a fresh editor", ed2 !== (ed1 as unknown));
		// The wrapped editor also fires for a NON-empty submit after a restart.
		rig.ctx.model = MODEL;
		ed2.handleInput("\r");
		check("fresh editor still wired to the empty-Enter path (queue empty → no send)", rig.pi.sentUserMessages.length === 0);
	}

	// -- summary -----------------------------------------------------------------

	console.log("");
	if (failures.length === 0) {
		console.log(`ALL ${pass} CHECKS PASSED`);
		process.exit(0);
	} else {
		console.log(`${failures.length} FAILURE(S), ${pass} passed:`);
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
