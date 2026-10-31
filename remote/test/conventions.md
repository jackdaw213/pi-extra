// Conventions for pi-remote tests (node:test, zero new dependencies).
//
// - One file per seam area, named <area>.test.mjs, next to this file.
// - Tests verify external behavior at public seams only — never internals.
// - The WebSocket boundary seam imports the ws client from the hub install:
//     import WebSocket from "../hub/node_modules/ws/index.js";
//   If that import fails, run `npm install` inside hub/ first.
// - To boot a local hub for boundary tests, always use a throwaway port and
//   throwaway config:
//     PI_REMOTE_PORT=0 PI_REMOTE_PASSWORD=test PI_REMOTE_TOKENS_FILE=/tmp/...
//   NEVER touch the deployed hub on the home lab from tests.
export {}
