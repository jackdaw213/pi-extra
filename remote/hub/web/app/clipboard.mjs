// Composer clipboard helper — image files from a paste event, DOM-free so it
// is testable in Node. The paste handler in attach.mjs decides policy (mixed
// clipboards, upload caps); this only extracts the candidate files.
export function pickImageFiles(items) {
  if (!items || typeof items[Symbol.iterator] !== "function") return [];
  const files = [];
  for (const item of items) {
    if (!item || item.kind !== "file") continue;
    if (typeof item.type !== "string" || !item.type.startsWith("image/")) continue;
    const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
    if (file) files.push(file);
  }
  return files;
}

// Pending-attachment budget: the hub rejects the WHOLE message when combined
// attachment bytes exceed the cap, so the composer enforces the same total
// budget locally. Returns the split between accepted and rejected files.
export function filterAttachable(files, pendingBytes, maxTotalBytes) {
  const accepted = [];
  const rejected = [];
  let total = pendingBytes || 0;
  for (const file of files || []) {
    const size = file && typeof file.size === "number" ? file.size : 0;
    if (total + size > maxTotalBytes) {
      rejected.push(file);
      continue;
    }
    total += size;
    accepted.push(file);
  }
  return { accepted, rejected };
}
