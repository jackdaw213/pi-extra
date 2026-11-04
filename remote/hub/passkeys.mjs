// Passkey (WebAuthn) login for the phone dashboard — docs/SPEC.md §10.
//
// The hub stays single-user: the password is the root of trust, and a passkey
// is an ADDITIONAL unlock for a device that already signed in with the
// password once (registration requires the pr_auth cookie). Login with a
// passkey mints the exact same stateless pr_auth cookie as the password, so
// the WS push channel and every authed endpoint work unchanged.
//
// Feature gate: passkeys only work over HTTPS (secure context — browsers
// refuse navigator.credentials on plain HTTP), and the RP ID must match the
// serving domain. Both come from env:
//   PI_REMOTE_RP_ID     e.g. "pi-remote.example.duckdns.org" — unset disables
//                       every passkey endpoint (login falls back to password)
//   PI_REMOTE_ORIGIN    expected origin(s), comma-separated; default
//                       https://<RP_ID> (NPM serving on 443)
// State: challenges are NOT stored server-side. The options endpoint wraps
// the challenge in an HMAC token (stateless, like the auth cookie); the
// client posts it back and the server checks the MAC before verifying —
// a restart between options and verify changes nothing. Credentials live in
// a JSON file next to the tokens file (same volume, same trust domain).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";

const TOKEN_TTL_MS = 5 * 60_000;
const CHALLENGE_SECRET_PREFIX = "pi-remote-passkey-challenge:";
const RP_NAME = "pi-remote";

function b64url(buf) {
	return Buffer.from(buf).toString("base64url");
}

// `<challengeB64url>.<expiryMs>.<hmac>` — base64url has no ".", so a plain
// split is unambiguous. The MAC proves the challenge came from this hub;
// the expiry bounds the replay window.
function signChallenge(password, challenge, nowMs) {
	const expiry = String(nowMs + TOKEN_TTL_MS);
	const payload = `${challenge}.${expiry}`;
	const mac = createHmac("sha256", createHash("sha256").update(CHALLENGE_SECRET_PREFIX + password).digest())
		.update(payload)
		.digest("base64url");
	return `${payload}.${mac}`;
}

// Returns { challenge } for a well-formed, unexpired, correctly signed token,
// or null for anything else.
function checkChallengeToken(password, token, nowMs) {
	if (typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [challenge, expiry, mac] = parts;
	const expected = createHmac("sha256", createHash("sha256").update(CHALLENGE_SECRET_PREFIX + password).digest())
		.update(`${challenge}.${expiry}`)
		.digest("base64url");
	const a = Buffer.from(expected);
	const b = Buffer.from(mac);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	const expMs = Number(expiry);
	if (!Number.isSafeInteger(expMs) || nowMs > expMs) return null;
	if (typeof challenge !== "string" || challenge.length === 0) return null;
	return { challenge };
}

export function createPasskeyStore({ password, file, rpId, origins, now = () => Date.now() }) {
	// Disabled unless an RP ID is configured: without it the browser cannot
	// even form credentials, so every endpoint answers 400 and the UI hides
	// its passkey controls.
	const enabled = typeof rpId === "string" && rpId.length > 0 && origins.length > 0;

	// File format (PI_REMOTE_PASSKEYS_FILE, default next to the tokens file):
	// { userId, credentials: [{ id, publicKey, counter, deviceType, backedUp, createdAt }] }
	// id/publicKey are base64url strings; the store owns all file I/O.
	let userId = "";
	let credentials = [];
	function load() {
		try {
			const data = JSON.parse(readFileSync(file, "utf8"));
			if (data && typeof data.userId === "string") userId = data.userId;
			if (Array.isArray(data.credentials)) credentials = data.credentials.filter((c) => c && typeof c.id === "string");
		} catch {
			/* first run or unreadable file: start empty */
		}
		if (!userId) userId = randomBytes(32).toString("base64url");
	}

	function save() {
		const tmp = file + ".tmp";
		writeFileSync(tmp, JSON.stringify({ userId, credentials }, null, 2), { mode: 0o600 });
		renameSync(tmp, file);
	}

	load();

	function status() {
		return { enabled, registered: credentials.length > 0, count: credentials.length };
	}

	async function registrationOptions() {
		const options = await generateRegistrationOptions({
			rpName: RP_NAME,
			rpID: rpId,
			userID: new Uint8Array(Buffer.from(userId, "base64url")),
			userName: "pi-remote",
			// Face ID is the point of the feature: require the biometric.
			authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
			excludeCredentials: credentials.map((c) => ({ id: c.id, transports: c.transports })),
		});
		return { options, token: signChallenge(password, options.challenge, now()) };
	}

	// verify with the stored public key, then persist. Throws on any failure —
	// the caller maps that to a 400.
	async function register(response, token) {
		const ch = checkChallengeToken(password, token, now());
		if (!ch) throw new Error("The passkey challenge expired or is invalid. Try again.");
		const verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: ch.challenge,
			expectedOrigin: origins,
			expectedRPID: rpId,
			requireUserVerification: true,
		});
		if (!verification.verified || !verification.registrationInfo?.credential) {
			throw new Error("The passkey could not be verified.");
		}
		const credential = verification.registrationInfo.credential;
		// Replace any entry with the same credential id (re-registration).
		credentials = credentials.filter((c) => c.id !== credential.id);
		credentials.push({
			id: credential.id,
			publicKey: b64url(credential.publicKey),
			counter: credential.counter ?? 0,
			deviceType: verification.registrationInfo.credentialDeviceType || "singleDevice",
			backedUp: verification.registrationInfo.credentialBackedUp === true,
			transports: Array.isArray(credential.transports) ? credential.transports : [],
			createdAt: new Date(now()).toISOString(),
		});
		save();
		return { id: credential.id };
	}

	async function authenticationOptions() {
		if (credentials.length === 0) throw new Error("No passkey is registered on this hub yet.");
		const options = await generateAuthenticationOptions({
			rpID: rpId,
			userVerification: "required",
			// Empty allowCredentials = discoverable-credential flow: the phone
			// offers every passkey scoped to this RP ID, iCloud-synced ones
			// included — right for a single-user hub.
			allowCredentials: [],
		});
		return { options, token: signChallenge(password, options.challenge, now()) };
	}

	// verify + counter check, then update the stored counter. Throws on any
	// failure — the caller maps that to a 401.
	async function login(response, token) {
		const ch = checkChallengeToken(password, token, now());
		if (!ch) throw new Error("The passkey challenge expired or is invalid. Try again.");
		const credential = credentials.find((c) => c.id === response?.id);
		if (!credential) throw new Error("This passkey is not registered on this hub.");
		const verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: ch.challenge,
			expectedOrigin: origins,
			expectedRPID: rpId,
			requireUserVerification: true,
			credential: {
				id: credential.id,
				publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
				counter: credential.counter,
				transports: credential.transports,
			},
		});
		if (!verification.verified) throw new Error("The passkey could not be verified.");
		// Counter policy: enforce monotonicity only when BOTH sides report a
		// real counter — iCloud-synced passkeys (multiDevice) legitimately stay
		// at 0 forever, and a hard check would lock them out.
		const newCounter = verification.authenticationInfo.newCounter;
		if (newCounter > 0 && credential.counter > 0 && newCounter <= credential.counter) {
			throw new Error("This passkey may be cloned; login refused.");
		}
		// Never store 0 over a real counter: the stored value is the anti-replay
		// baseline, and a zero report (synced passkey quirk) must not erase it.
		if (newCounter > 0) credential.counter = newCounter;
		save();
		return { id: credential.id };
	}

	function remove(id) {
		const before = credentials.length;
		credentials = typeof id === "string" ? credentials.filter((c) => c.id !== id) : [];
		if (credentials.length !== before) save();
		return before - credentials.length;
	}

	return {
		enabled,
		rpId,
		origins,
		status,
		registrationOptions,
		register,
		authenticationOptions,
		login,
		remove,
	};
}

// Convenience for server.mjs: parse the origin list env value.
export function parseOrigins(env, rpId) {
	const raw = (env || "").trim();
	if (raw) return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	return rpId ? [`https://${rpId}`] : [];
}

export function passkeysFileExists(file) {
	return existsSync(file);
}
