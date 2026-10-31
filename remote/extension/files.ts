// pi-remote extension — the LLM-callable tool that sends a file to the phone.
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { Type } from "typebox";
import { A_FILE, MAX_FILE_BYTES } from "../shared/protocol.mjs";

export interface SendFileDeps {
	send: (type: string, payload: Record<string, unknown>) => boolean;
	getSessionId: () => string;
}

const SEND_PARAMS = Type.Object({
	path: Type.String({ description: "Absolute path of the file to send" }),
});

export function registerSendFileTool(pi: any, deps: SendFileDeps): void {
	pi.registerTool({
		name: "send_file_to_phone",
		description:
			"Send a file from this machine to the user's phone via pi-remote. Use it when the user asks to send a file to the phone.",
		parameters: SEND_PARAMS,
		annotations: { readOnlyHint: true },
		exposure: "direct",
		async execute(_toolCallId: string, params: { path: string }) {
			const path = typeof params?.path === "string" ? params.path.trim() : "";
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: message }],
				isError: true,
			});
			if (!path || !isAbsolute(path)) return fail(`send_file_to_phone needs an absolute path, got: ${path || "(empty)"}`);
			let size: number;
			try {
				const st = statSync(path);
				if (!st.isFile()) return fail(`Not a regular file: ${path}`);
				size = st.size;
			} catch (err) {
				return fail(`Cannot stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (size > MAX_FILE_BYTES) {
				return fail(`File is too large to send (${size} bytes; limit ${MAX_FILE_BYTES}): ${path}`);
			}
			try {
				const name = basename(path);
				const b64 = readFileSync(path).toString("base64");
				const sent = deps.send(A_FILE, { sessionId: deps.getSessionId(), op: "put", name, b64 });
				if (!sent) return fail(`Not connected to the pi-remote hub; could not send ${path}`);
				return {
					content: [{ type: "text" as const, text: `Sent to your phone: ${name}` }],
					details: { sent: true, name },
				};
			} catch (err) {
				return fail(`Could not send ${path}: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
