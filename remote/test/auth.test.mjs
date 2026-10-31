// Seam: phoneapi auth tokens — stateless, signed, restart-proof.
// A cookie minted by one hub process must validate on a fresh process with
// the same password (refresh/redeploy must not log the user out), must
// expire after the idle window, and must reject tampering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintAuthToken, verifyAuthToken } from "../hub/phoneapi.mjs";

const PW = "test-pw";
const NOW = 1_700_000_000_000;
const IDLE = 15 * 60_000;

test("a minted token verifies while inside its idle window", () => {
  const token = mintAuthToken(PW, NOW, IDLE);
  assert.deepEqual(verifyAuthToken(PW, token, NOW + IDLE - 1000), { ok: true, expired: false });
});

test("a token past its idle window verifies as expired", () => {
  const token = mintAuthToken(PW, NOW, IDLE);
  assert.deepEqual(verifyAuthToken(PW, token, NOW + IDLE + 1), { ok: true, expired: true });
});

test("a token minted for a different password does not verify", () => {
  const token = mintAuthToken(PW, NOW, IDLE);
  assert.equal(verifyAuthToken("other-pw", token, NOW), null);
});

test("a tampered token does not verify", () => {
  const token = mintAuthToken(PW, NOW, IDLE);
  const [payload] = token.split(".");
  const bumped = String(Number(payload) + 5000);
  assert.equal(verifyAuthToken(PW, `${bumped}.${token.split(".")[1]}`, NOW), null);
  assert.equal(verifyAuthToken(PW, `${payload}.deadbeef`, NOW), null);
  assert.equal(verifyAuthToken(PW, "garbage", NOW), null);
});

test("tokens for the same password and moment are deterministic — restart-safe", () => {
  assert.equal(mintAuthToken(PW, NOW, IDLE), mintAuthToken(PW, NOW, IDLE));
});
