/**
 * session-autoname — automatically names new sessions.
 *
 * When the FIRST real user message of a session arrives (interactive, non-empty,
 * not a slash command) and the session has no name yet, generate a short title
 * (3-6 words, <=48 chars) from the prompt via a cheap nested model call, then
 * set it as the session name.
 *
 * Strictly fire-and-forget: the naming call never delays or blocks the run.
 * Every failure is silent; if the model reply is unusable the title falls back
 * to the first words of the prompt. At most one naming attempt per session;
 * re-armed by `session_start` (so /new starts naming again). A session that
 * already has a name (/name, --name, resume) is skipped for good.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

const TITLE_SYSTEM_PROMPT =
	"Reply with ONLY a 3-6 word title summarizing this conversation start. No quotes, no punctuation at the end.";
const TITLE_MAX_CHARS = 48;
const TITLE_MAX_TOKENS = 32;
const TITLE_TIMEOUT_MS = 10_000;
const PROMPT_EXCERPT_CHARS = 500;
const FALLBACK_WORD_COUNT = 5;
/** localllm server "vllm" (pi-localllm-provider slugs the server name into the provider id). */
const PREFERRED_PROVIDER = "vllm";
const PREFERRED_MODEL_ID = "glm53";
const LAST_RESORT_TITLE = "New session";
/**
 * glm53 thinks by default: at maxTokens 32 the whole budget goes to reasoning
 * tokens and the reply comes back empty (verified against the server). "low"
 * is the lowest effort the server supports (thinkingLevelMap maps off/null)
 * and turns thinking off, leaving the full budget for the title.
 */
const TITLE_REASONING = "low" as const;

/** The cheap local model used for the title call: the localllm glm53, else the session model. */
function resolveTitleModel(ctx: ExtensionContext): Model<any> | undefined {
	try {
		const registry = ctx.modelRegistry as
			| { find?(provider: string, modelId: string): unknown; getAll?(): unknown[] }
			| undefined;
		const direct = registry?.find?.(PREFERRED_PROVIDER, PREFERRED_MODEL_ID);
		if (direct) return direct as Model<any>;
		const scanned = registry
			?.getAll?.()
			.find((m): m is Model<any> => (m as { id?: string })?.id === PREFERRED_MODEL_ID);
		if (scanned) return scanned;
	} catch {
		// registry in an odd state — fall through to the session model
	}
	return ctx.model;
}

/** Strip quotes/backticks, collapse whitespace, drop trailing punctuation, cap length. */
function sanitizeTitle(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	let title = raw
		.replace(/[`"']/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!,;:?—–-]+$/u, "")
		.trim();
	if (!title || !/\p{L}/u.test(title)) return undefined;
	if (title.length <= TITLE_MAX_CHARS) return title;
	const cut = title.slice(0, TITLE_MAX_CHARS);
	const lastSpace = cut.lastIndexOf(" ");
	title = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
	return title || undefined;
}

/** Last-resort title: the first words of the prompt itself. */
function fallbackTitle(excerpt: string): string {
	const words = excerpt
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean)
		.slice(0, FALLBACK_WORD_COUNT)
		.join(" ");
	return sanitizeTitle(words) ?? LAST_RESORT_TITLE;
}

function abortSignalAfter(ms: number): AbortSignal {
	if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
	return controller.signal;
}

/** Generate the title and set it. Never throws; never notifies. */
async function nameSession(promptText: string, ctx: ExtensionContext, setName: (title: string) => void): Promise<void> {
	try {
		const excerpt = promptText.slice(0, PROMPT_EXCERPT_CHARS);
		let replyText = "";
		const model = resolveTitleModel(ctx);
		if (model) {
			try {
				const stream = ctx.modelRegistry.streamSimple(
					model,
					{
						systemPrompt: TITLE_SYSTEM_PROMPT,
						messages: [
							{ role: "user", content: [{ type: "text", text: excerpt }], timestamp: Date.now() },
						],
					},
					{ maxTokens: TITLE_MAX_TOKENS, signal: abortSignalAfter(TITLE_TIMEOUT_MS), reasoning: TITLE_REASONING },
				);
				const reply = await stream.result();
				replyText = (reply?.content ?? [])
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join(" ");
			} catch {
				// model call failed or timed out — fall back to prompt words below
			}
		}
		// Re-check: the user may have named the session while the call was in flight.
		if (replyText) {
			const fromModel = sanitizeTitle(replyText);
			if (fromModel) {
				setName(fromModel);
				return;
			}
		}
		setName(fallbackTitle(excerpt));
	} catch {
		// naming is best-effort — fail silently
	}
}

export default function sessionAutoname(pi: ExtensionAPI) {
	// One naming attempt per session; re-armed on every session start (/new, resume, fork).
	let armed = true;

	pi.on("session_start", () => {
		try {
			armed = true;
		} catch {
			// ignore
		}
	});

	pi.on("input", (event, ctx) => {
		try {
			if (event.source !== "interactive") return undefined;
			const text = (event.text ?? "").trim();
			if (!text || text.startsWith("/")) return undefined;
			if (!armed) return undefined;
			armed = false; // consume the single attempt, even if naming fails below
			if (pi.getSessionName() !== undefined) return undefined; // already named: skip for good
			void nameSession(text, ctx, (title) => {
				try {
					if (pi.getSessionName() === undefined) pi.setSessionName(title);
				} catch {
					// ignore
				}
			});
		} catch {
			// never let naming affect input handling
		}
		return undefined;
	});
}
