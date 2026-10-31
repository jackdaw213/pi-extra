// pi-remote extension — hub spawn command → shared/spawn.mjs wrapper.
import { A_SPAWN_RESULT } from "../shared/protocol.mjs";
import { runSpawn, normalizeSessionKind } from "../shared/spawn.mjs";
import type { RemoteClient } from "./client";

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Fire-and-forget: runSpawn builds the systemd-run transient unit; the new
// session's own extension dials the hub by itself. We only acknowledge.
// kind (ADR 0006) rides the spawn frame; buildSpawnArgs validates it against
// the strict whitelist and defaults it to "temp".
export async function handleSpawn(client: RemoteClient, f: any): Promise<void> {
	const ref = f.ref;
	try {
		const kind = f.kind === undefined || f.kind === null ? undefined : normalizeSessionKind(f.kind);
		const result = await runSpawn({
			name: typeof f.name === "string" ? f.name : undefined,
			kind,
		});
		if (result.ok) client.send(A_SPAWN_RESULT, { ref, ok: true });
		else client.send(A_SPAWN_RESULT, { ref, ok: false, error: result.error });
	} catch (err) {
		client.send(A_SPAWN_RESULT, { ref, ok: false, error: errText(err) });
	}
}
