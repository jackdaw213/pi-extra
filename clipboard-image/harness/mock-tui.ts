// Mock of @earendil-works/pi-tui for the headless pi-image harness.
// Exports the runtime members index.ts uses: truncateToWidth and
// visibleWidth. The Image component and matchesKey were removed together
// with the preview UI they served.

/** Count visible cells: escape sequences (CSI, OSC, APC) are zero-width. */
export function visibleWidth(line: string): number {
	let width = 0;
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\x1b") {
			if (line[i + 1] === "[") {
				// CSI: ends with a byte 0x40–0x7E
				i += 2;
				while (i < line.length && !(line.charCodeAt(i) >= 0x40 && line.charCodeAt(i) <= 0x7e)) i++;
				i++;
				continue;
			}
			if (line[i + 1] === "]") {
				const end = line.indexOf("\x1b\\", i);
				const bel = line.indexOf("\x07", i);
				if (end !== -1 && (bel === -1 || end < bel)) i = end + 2;
				else if (bel !== -1) i = bel + 1;
				else i = line.length;
				continue;
			}
			i += 2; // unknown escape: skip ESC + next
			continue;
		}
		const cp = line.codePointAt(i) as number;
		// Rough wide-char handling for CJK ranges; enough for the harness.
		width += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60)) ? 2 : 1;
		i += cp > 0xffff ? 2 : 1;
	}
	return width;
}

/** Truncate to a visible width, keeping escape sequences intact when possible. */
export function truncateToWidth(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let out = "";
	let w = 0;
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\x1b") {
			let end: number;
			if (line[i + 1] === "[") {
				end = i + 2;
				while (end < line.length && !(line.charCodeAt(end) >= 0x40 && line.charCodeAt(end) <= 0x7e)) end++;
				end++;
			} else if (line[i + 1] === "]") {
				const e = line.indexOf("\x1b\\", i);
				const bel = line.indexOf("\x07", i);
				end = e !== -1 && (bel === -1 || e < bel) ? e + 2 : bel !== -1 ? bel + 1 : line.length;
			} else {
				end = i + 2;
			}
			out += line.slice(i, end);
			i = end;
			continue;
		}
		if (w >= width) break;
		const cp = line.codePointAt(i) as number;
		const cw = cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60)) ? 2 : 1;
		if (w + cw > width) break;
		out += line.slice(i, i + (cp > 0xffff ? 2 : 1));
		w += cw;
		i += cp > 0xffff ? 2 : 1;
	}
	return out;
}
