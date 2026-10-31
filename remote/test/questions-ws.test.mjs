// Questions over the hub WebSocket boundary (questions-ws).
// Boots a REAL hub on a throwaway port with throwaway env; a fake agent
// connects on /agent, a fake phone logs in and connects on /ws. Verifies:
// agent A_QUESTION -> phone receives it; phone POST /api/answer -> agent
// receives question_answer with the right callId. Never touches the lab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "../hub/node_modules/ws/index.js";

const HUB_ROOT = new URL("../hub/", import.meta.url).pathname;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const PASSWORD = "test-pw";
const TOKEN = "test-token";
const MACHINE = { id: "test-machine", hostname: "test-host", os: "linux", release: "x", addresses: ["127.0.0.1"] };
const SESSION = {
	id: "sess-1",
	name: "test",
	cwd: "/tmp",
	model: null,
	thinkingLevel: null,
	state: "idle",
	pid: 1,
	mode: "remote",
	startedAt: new Date().toISOString(),
};

function waitFor(fn, what, ms = 5000) {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const tick = async () => {
			let v;
			try {
				v = await fn();
			} catch {}
			if (v !== undefined && v !== false) return resolve(v);
			if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

function wsReceive(ws, match, what) {
	// Collect frames until one matches; returns it. match(frame) -> bool.
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), 5000);
		const onData = (raw) => {
			const f = JSON.parse(String(raw));
			if (match(f)) {
				clearTimeout(timer);
				ws.off("message", onData);
				resolve(f);
			}
		};
		ws.on("message", onData);
	});
}

test("A_QUESTION relays agent -> phone; /api/answer relays phone -> agent", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-remote-ws-"));
	const tokensFile = join(dir, "tokens");
	writeFileSync(tokensFile, TOKEN + "\n");

	const hub = spawn(process.execPath, [join(HUB_ROOT, "server.mjs")], {
		env: {
			...process.env,
			PI_REMOTE_PORT: String(PORT),
			PI_REMOTE_PASSWORD: PASSWORD,
			PI_REMOTE_TOKENS_FILE: tokensFile,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let hubLogs = "";
	hub.stdout.on("data", (d) => (hubLogs += d));
	hub.stderr.on("data", (d) => (hubLogs += d));
	t.after(() => {
		hub.kill("SIGTERM");
		hub.on("exit", () => {});
	});

	// Wait for the hub to accept HTTP before dialing.
	await waitFor(async () => {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			return r.ok ? true : undefined;
		} catch {
			return undefined;
		}
	}, "hub health", 10000);

	// --- agent connects and registers -------------------------------------
	const agent = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
	await new Promise((res, rej) => {
		agent.on("open", res);
		agent.on("error", rej);
	});
	agent.send(JSON.stringify({ v: 1, type: "hello", machine: MACHINE, session: SESSION, token: TOKEN }));
	await wsReceive(agent, (f) => f.type === "welcome", "welcome");
	// Swallow the periodic hub pings without failing later receives.
	// Swallow the periodic hub pings without failing later receives.
	agent.on("message", () => {});

	// --- phone logs in and opens the push channel --------------------------
	const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password: PASSWORD }),
	});
	assert.equal(login.status, 204);
	const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
	assert.ok(cookie.startsWith("pr_auth="));

	const phone = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie } });
	await new Promise((res, rej) => {
		phone.on("open", res);
		phone.on("error", rej);
	});
	// First frame is the registry snapshot; wait for our session to appear.
	await wsReceive(phone, (f) => f.type === "registry" && JSON.stringify(f).includes("sess-1"), "registry with sess-1");

	// --- agent asks; phone receives the question ---------------------------
	const callId = "call-123";
	agent.send(
		JSON.stringify({
			v: 1,
			type: "question",
			sessionId: SESSION.id,
			callId,
			toolName: "ask_user_question",
			question: "Deploy now?",
			options: ["yes", "no"],
			multiSelect: false,
		}),
	);
	const qf = await wsReceive(phone, (f) => f.type === "question", "question frame on /ws");
	assert.equal(qf.sessionId, SESSION.id);
	assert.equal(qf.callId, callId);
	assert.deepEqual(qf.options, ["yes", "no"]);
	assert.equal(qf.multiSelect, false);
	assert.equal(qf.toolName, "ask_user_question");
	assert.equal(qf.question, "Deploy now?");

	// --- phone answers by value; agent receives question_answer ------------
	// The hub relays to the agent synchronously before answering 202, so the
	// agent listener must attach BEFORE the POST fires.
	const afP = wsReceive(agent, (f) => f.type === "question_answer", "question_answer on /agent");
	const ans = await fetch(`http://127.0.0.1:${PORT}/api/answer`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ machineId: MACHINE.id, sessionId: SESSION.id, callId, value: "yes" }),
	});
	assert.equal(ans.status, 202);
	const af = await afP;
	assert.equal(af.callId, callId);
	assert.equal(af.sessionId, SESSION.id);
	assert.equal(af.value, "yes");
	assert.equal(af.custom, undefined);
	assert.equal(af.cancelled, undefined);

	// --- custom answer ------------------------------------------------------
	const af2P = wsReceive(agent, (f) => f.type === "question_answer" && f.callId === "call-9", "custom question_answer");
	const ans2 = await fetch(`http://127.0.0.1:${PORT}/api/answer`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ machineId: MACHINE.id, sessionId: SESSION.id, callId: "call-9", custom: "do it differently" }),
	});
	assert.equal(ans2.status, 202);
	const af2 = await af2P;
	assert.equal(af2.custom, "do it differently");
	assert.equal(af2.value, undefined);

	// --- cancelled answer ---------------------------------------------------
	const af3P = wsReceive(agent, (f) => f.type === "question_answer" && f.callId === "call-10", "cancelled question_answer");
	await fetch(`http://127.0.0.1:${PORT}/api/answer`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ machineId: MACHINE.id, sessionId: SESSION.id, callId: "call-10", cancelled: true }),
	});
	const af3 = await af3P;
	assert.equal(af3.cancelled, true);

	// --- /api/answer rejects bad bodies -------------------------------------
	const bad = await fetch(`http://127.0.0.1:${PORT}/api/answer`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ machineId: MACHINE.id, sessionId: SESSION.id, callId: "x" }),
	});
	assert.equal(bad.status, 400);
	const unauth = await fetch(`http://127.0.0.1:${PORT}/api/answer`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ machineId: MACHINE.id, sessionId: SESSION.id, callId: "x", value: "v" }),
	});
	assert.equal(unauth.status, 401);
	const missing = await fetch(`http://127.0.0.1:${PORT}/api/answer`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ machineId: MACHINE.id, sessionId: "ghost", callId: "x", value: "v" }),
	});
	assert.equal(missing.status, 404);

	agent.close();
	phone.close();
});
