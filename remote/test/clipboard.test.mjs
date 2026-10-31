// Seam: shared clipboard extraction for the composer — image files from a
// paste event's DataTransferItemList, without touching the DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickImageFiles } from "../hub/web/app/clipboard.mjs";

test("picking image files from clipboard items", () => {
  const png = { name: "screenshot.png" };
  const jpeg = { name: "photo.jpg" };
  const items = [
    { kind: "string", type: "text/plain", getAsFile: () => null },
    { kind: "file", type: "image/png", getAsFile: () => png },
    { kind: "file", type: "text/plain", getAsFile: () => ({ name: "x.txt" }) },
    { kind: "file", type: "image/jpeg", getAsFile: () => jpeg },
  ];
  assert.deepEqual(pickImageFiles(items), [png, jpeg]);
});

test("non-images and broken items are ignored", () => {
  const items = [
    { kind: "file", type: "application/pdf", getAsFile: () => ({ name: "a.pdf" }) },
    { kind: "file", type: "image/png" }, // getAsFile missing
    { kind: "file", type: "image/png", getAsFile: () => null },
  ];
  assert.deepEqual(pickImageFiles(items), []);
});

test("missing or malformed clipboard data yields no files", () => {
  assert.deepEqual(pickImageFiles(null), []);
  assert.deepEqual(pickImageFiles(undefined), []);
  assert.deepEqual(pickImageFiles("nope"), []);
});

// Composer pending attachments: a total-size budget, not per-file — the hub
// rejects the whole message when the combined attachment bytes exceed the cap.
import { filterAttachable } from "../hub/web/app/clipboard.mjs";

test("pending attachment budget accepts files that fit the total cap", () => {
  const a = { name: "a.png", size: 30 };
  const b = { name: "b.png", size: 15 };
  const r = filterAttachable([a, b], 0, 50); // 0 bytes already pending
  assert.deepEqual(r.accepted, [a, b]);
  assert.deepEqual(r.rejected, []);
});

test("pending attachment budget rejects files that would overflow it", () => {
  const a = { name: "a.png", size: 30 };
  const big = { name: "big.png", size: 40 };
  const r = filterAttachable([a, big], 0, 50);
  assert.deepEqual(r.accepted, [a]);
  assert.deepEqual(r.rejected, [big]);
});

test("pending attachment budget counts already-pending bytes", () => {
  const r = filterAttachable([{ name: "c.png", size: 25 }], 30, 50);
  assert.deepEqual(r.accepted, []);
  assert.deepEqual(r.rejected.length, 1);
});

test("zero-size and unnamed files pass through when the budget allows", () => {
  const r = filterAttachable([{ name: "", size: 0 }], 0, 50);
  assert.equal(r.accepted.length, 1);
});
