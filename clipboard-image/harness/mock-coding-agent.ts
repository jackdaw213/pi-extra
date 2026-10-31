// Mock of the @earendil-works/pi-coding-agent module surface that index.ts
// uses at RUNTIME (type imports are erased). Only CustomEditor is needed.
//
// Mirrors the real CustomEditor/Editor submit path from pi-tui 1.4.0
// (components/editor.js) closely enough to exercise the extension's
// submitValue wrap headlessly:
//   - handleInput("\r") → submitValue() (the base Editor's tui.input.submit
//     branch; disableSubmit is never set in pi 1.4.0).
//   - submitValue() = cancelAutocomplete + expandPasteMarkers(lines).trim(),
//     reset state, onChange(""), onSubmit(result) — the REAL order.
// The extension wraps submitValue on the INSTANCE, so this base stays
// untouched and tests can spy onSubmit/onChange like the mode does.

export class CustomEditor {
	disableSubmit = false;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	actionHandlers = new Map<string, () => void>();
	embedWorkingStatus = false;
	state: { lines: string[]; cursorLine: number; cursorCol: number } = { lines: [""], cursorLine: 0, cursorCol: 0 };

	constructor(
		_tui: unknown,
		_theme: unknown,
		_keybindings: unknown,
		_options?: { embedWorkingStatus?: boolean },
	) {}

	getText(): string {
		return this.state.lines.join("\n");
	}

	getExpandedText(): string {
		return this.getText();
	}

	setText(text: string): void {
		const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		this.state = {
			lines: normalized === "" ? [""] : normalized.split("\n"),
			cursorLine: 0,
			cursorCol: 0,
		};
	}

	insertTextAtCursor(text: string): void {
		const line = this.state.lines[this.state.cursorLine] ?? "";
		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);
		const merged = before + text + after;
		const lines = merged.split("\n");
		this.state.lines.splice(this.state.cursorLine, 1, ...lines);
		this.state.cursorCol = before.length + text.length;
		this.state.cursorLine = this.state.cursorLine + lines.length - 1;
	}

	handleInput(data: string): void {
		if (data === "\r") {
			if (this.disableSubmit) return;
			this.submitValue();
			return;
		}
		if (data.length > 0 && data.charCodeAt(0) >= 32) {
			this.insertTextAtCursor(data);
		}
	}

	cancelAutocomplete(): void {}

	submitValue(): void {
		this.cancelAutocomplete();
		const result = this.getExpandedText().trim();
		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}
}
