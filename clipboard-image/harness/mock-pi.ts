// Mock ExtensionAPI + ExtensionContext for the pi-image headless harness.
// Mirrors the relevant pi 1.4.0 interactive-mode semantics:
// - setWidget(key, factory) invokes the factory IMMEDIATELY and stores the
//   resulting component; setWidget(key, undefined) removes + disposes.
// - onTerminalInput(handler) stores the raw-input handler and returns an
//   unsubscribe (the extension registers none since the render-poke fix;
//   tests assert the listener list stays empty).
// - setStatus(key, text) records calls: pi's setExtensionStatus also pokes
//   requestRender unconditionally; the harness only asserts the call itself.

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface PiMockState {
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	shortcuts: Map<string, { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }>;
	appendedEntries: { type: string; data?: unknown }[];
	branchEntries: unknown[];
	/** pi.sendUserMessage calls, in order: content + options exactly as passed. */
	sentUserMessages: { content: unknown; options?: { deliverAs?: "steer" | "followUp" } | undefined }[];
	/** When true, pi.sendUserMessage throws SYNCHRONOUSLY (nothing dispatched). */
	failSendUserMessage: boolean;
}

export interface UiMockState {
	widgets: Map<string, unknown>;
	/** How many times a widget FACTORY was registered (flicker metric). */
	registrations: number;
	disposeCalls: number;
	notifies: { message: string; type: string }[];
	/** Text payloads handed to pasteToEditor, in call order. */
	pasted: string[];
	requestRenders: number;
	failNotify: boolean;
	failSetWidget: boolean;
	/** Raw-input handlers registered via ctx.ui.onTerminalInput, in order. */
	terminalInputListeners: ((data: string) => { consume?: boolean; data?: string } | undefined)[];
	/** setStatus calls, in order: the extension's render pokes land here. */
	setStatusCalls: { key: string; text: string | undefined }[];
	/** When true, setStatus throws (guarded-side-effect injection). */
	failSetStatus: boolean;
	/** Editor factories handed to setEditorComponent, in registration order. */
	editorFactories: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown)[];
}

export const tuiMock = {
	requestRenders: 0,
	requestRender(this: { requestRenders: number }): void {
		this.requestRenders++;
	},
};

export const themeMock = {
	fg(_name: string, s: string): string {
		return s;
	},
};

export function createPiMock(): PiMockState & {
	on(name: string, fn: (...args: unknown[]) => unknown): () => void;
	registerCommand(name: string, opts: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void;
	registerShortcut(id: string, opts: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }): void;
	appendEntry(type: string, data?: unknown): void;
	sendUserMessage(
		content: unknown,
		options?: { deliverAs?: "steer" | "followUp" } | undefined,
	): void;
	getSettings(): Record<string, unknown>;
} {
	const state: PiMockState = {
		handlers: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		appendedEntries: [],
		branchEntries: [],
		sentUserMessages: [],
		failSendUserMessage: false,
	};
	// Methods attach onto the state object itself, so scalar flags mutated via
	// the returned reference (rig.pi.failSendUserMessage) are visible to them.
	const api = state as PiMockState & {
		on(name: string, fn: (...args: unknown[]) => unknown): () => void;
		registerCommand(name: string, opts: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void;
		registerShortcut(id: string, opts: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }): void;
		appendEntry(type: string, data?: unknown): void;
		sendUserMessage(content: unknown, options?: { deliverAs?: "steer" | "followUp" } | undefined): void;
		getSettings(): Record<string, unknown>;
	};
	api.on = (name, fn) => {
		const list = state.handlers.get(name) ?? [];
		list.push(fn);
		state.handlers.set(name, list);
		return () => {
			const cur = state.handlers.get(name) ?? [];
			const i = cur.indexOf(fn);
			if (i !== -1) cur.splice(i, 1);
		};
	};
	api.registerCommand = (name, opts) => {
		state.commands.set(name, opts);
	};
	api.registerShortcut = (id, opts) => {
		state.shortcuts.set(id, opts);
	};
	api.appendEntry = (type, data) => {
		state.appendedEntries.push({ type, data });
	};
	/** Mirror of pi's ExtensionAPI.sendUserMessage: fire-and-forget, records the call. */
	api.sendUserMessage = (content, options) => {
		if (state.failSendUserMessage) {
			throw new Error("sendUserMessage forced failure");
		}
		state.sentUserMessages.push({ content, options });
	};
	api.getSettings = () => ({});
	return api;
}

export function createUiMock(): UiMockState {
	return {
		widgets: new Map(),
		registrations: 0,
		disposeCalls: 0,
		notifies: [],
		pasted: [],
		requestRenders: 0,
		failNotify: false,
		failSetWidget: false,
		failSetStatus: false,
		terminalInputListeners: [],
		setStatusCalls: [],
		editorFactories: [],
	};
}

export function createContextMock(pi: PiMockState, ui: UiMockState): ExtensionContext {
	const uiContext = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify(message: string, type?: "info" | "warning" | "error") {
			if (ui.failNotify) throw new Error("notify forced failure");
			ui.notifies.push({ message, type: type ?? "info" });
		},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget(key: string, content: unknown, _options?: { placement?: "aboveEditor" | "belowEditor" }) {
			if (ui.failSetWidget) throw new Error("setWidget forced failure");
			const existing = ui.widgets.get(key) as { dispose?(): void } | undefined;
			if (existing?.dispose) ui.disposeCalls++;
			ui.widgets.delete(key);
			if (content === undefined) return;
			if (Array.isArray(content)) {
				ui.widgets.set(key, content);
				return;
			}
			// Factory variant: pi invokes it immediately (verified in
			// interactive-mode.js setExtensionWidget) and stores the component.
			if (typeof content !== "function") throw new Error("unexpected setWidget content type");
			ui.registrations++;
			const component = (content as (tui: unknown, theme: unknown) => unknown)(tuiMock, themeMock);
			ui.widgets.set(key, component);
		},
		/** Mirror of pi 1.4.0 interactive-mode: onTerminalInput stores the handler and returns an unsubscribe. */
		onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
			ui.terminalInputListeners.push(handler);
			return () => {
				const i = ui.terminalInputListeners.indexOf(handler);
				if (i !== -1) ui.terminalInputListeners.splice(i, 1);
			};
		},
		/** Mirror of pi 1.4.0 setExtensionStatus: records the call; real pi also requestRenders unconditionally. */
		setStatus(key: string, text: string | undefined) {
			if (ui.failSetStatus) throw new Error("setStatus forced failure");
			ui.setStatusCalls.push({ key, text });
		},
		/** Mirror of setCustomEditorComponent: stores the factory (the real mode invokes it at once). */
		setEditorComponent(factory: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined) {
			if (factory === undefined) return;
			ui.editorFactories.push(factory);
		},
		getEditorComponent() {
			return ui.editorFactories.at(-1);
		},
		setHeader() {},
		setTitle() {},
		pasteToEditor(text: string) {
			ui.pasted.push(text);
		},
		setEditorText() {},
		getEditorText() {
			return "";
		},
		editor: async () => undefined,
		addAutocompleteProvider() {},
		theme: themeMock as unknown as ExtensionUIContext["theme"],
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false }),
		getToolsExpanded: () => false,
		setToolsExpanded() {},
} as unknown as ExtensionUIContext;
	return {
		ui: uiContext,
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/pi-image-harness",
		sessionManager: {
			getBranch: () => pi.branchEntries,
		} as unknown as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "",
	} as ExtensionContext;
}

/** Flush microtasks so async extension handlers reach their awaited points. */
export async function settle(times = 6): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}
