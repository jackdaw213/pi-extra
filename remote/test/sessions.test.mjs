// Seam: shared/sessions.mjs — locating pi session transcript files by id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSessionFile } from "../shared/sessions.mjs";

test("findSessionFile locates a session file by id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-sessions-"));
  const proj = join(dir, "----tmp-proj--");
  await mkdir(proj);
  const file = join(proj, "2026-11-26T10-10-10-000Z_abc-123.jsonl");
  await writeFile(file, "");
  const found = await findSessionFile("abc-123", { sessionsDir: dir });
  assert.equal(found, file);
});

test("findSessionFile returns null when no file matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-sessions-"));
  assert.equal(await findSessionFile("missing-id", { sessionsDir: dir }), null);
});

test("findSessionFile picks the newest file when several match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-sessions-"));
  const proj = join(dir, "----tmp-proj--");
  await mkdir(proj);
  await writeFile(join(proj, "2026-11-26T10-10-10-000Z_dup-id.jsonl"), "old");
  await writeFile(join(proj, "2026-11-27T10-10-10-000Z_dup-id.jsonl"), "new");
  const found = await findSessionFile("dup-id", { sessionsDir: dir });
  assert.equal(found, join(proj, "2026-11-27T10-10-10-000Z_dup-id.jsonl"));
});
