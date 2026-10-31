// inputlog-ext — logs every raw terminal input chunk pi receives.
// Diagnosis only; loaded with `-e tools/inputlog-ext/index.ts`.
// Output file: $PI_INPUTLOG (default /tmp/pi-repro/pi-input.log), one JSON
// line per chunk: { t: epoch ms, len: chars, data: raw chunk }.
import * as fs from "node:fs";

const OUT = process.env.PI_INPUTLOG ?? "/tmp/pi-repro/pi-input.log";

interface Ui {
	onTerminalInput: (fn: (data: string) => undefined) => () => void;
}

export default function (pi: {
	on: (event: string, handler: (event: unknown, ctx: { ui: Ui }) => Promise<void>) => void;
}) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.onTerminalInput((data: string) => {
			try {
				fs.appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), len: data.length, data })}\n`);
			} catch {
				// diagnostics must never break input
			}
			return undefined;
		});
	});
}
