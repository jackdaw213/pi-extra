// pi-remote shared sessions — locate pi session transcript files on disk.
// Plain ESM, zero dependencies. Runs on Node 22 and Bun inside pi (extension).
//
// pi writes session transcripts as JSONL under
//   ~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
// (see pi docs/session-format.md). The filename embeds the session id after
// the last underscore.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Returns the absolute path of the newest session file for `sessionId`, or
// null when none exists. `opts.sessionsDir` overrides the sessions root
// (tests); `opts.home` overrides the home directory (tests).
export async function findSessionFile(sessionId, opts = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const root = opts.sessionsDir || join(opts.home || homedir(), ".pi", "agent", "sessions");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      // Filename shape: <timestamp>_<session-id>.jsonl — the id is what
      // follows the LAST underscore, so timestamps with hyphens stay safe.
      const idx = f.lastIndexOf("_");
      if (idx === -1 || f.slice(idx + 1, -".jsonl".length) !== sessionId) continue;
      const full = join(dir, f);
      if (!best || f > best.name) best = { name: f, path: full };
    }
  }
  return best ? best.path : null;
}
