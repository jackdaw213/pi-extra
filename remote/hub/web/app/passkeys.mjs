// Passkey (Face ID) login for the phone — talks to /api/passkey/* and the
// browser WebAuthn API through the vendored SimpleWebAuthnBrowser UMD
// (vendor/simplewebauthn/, see vendor/VERSIONS.md).
//
// UX surface:
//   - Login view: "Sign in with Face ID" button, visible when the hub has the
//     feature enabled AND a passkey registered (public /api/passkey/enabled).
//   - Dashboard: a one-time banner offering to add the device's passkey once
//     a password login has authenticated the session. Dismissal persists in
//     localStorage; a registered passkey turns the banner into management
//     (remove) instead of an offer.
// WebAuthn needs a secure context (HTTPS): on plain HTTP the buttons stay
// hidden regardless of server config.
import * as api from "./api.mjs";
import { toast } from "./ui.mjs";

const DISMISS_KEY = "pr_passkey_banner_dismissed";
const browser = typeof window !== "undefined" ? window.SimpleWebAuthnBrowser : null;

function supported() {
	return (
		!!browser &&
		typeof window.isSecureContext === "boolean" &&
		window.isSecureContext &&
		!!window.PublicKeyCredential
	);
}

// Login view: show the button when usable, wire the click. Returns nothing;
// safe to call on every route to login.
export async function wireLoginButton(button) {
	if (!button) return;
	let usable = false;
	try {
		const st = await api.passkeyStatus();
		usable = st.enabled && st.registered;
	} catch {
		usable = false; // hub unreachable: password login still works
	}
	if (!usable || !supported()) {
		button.hidden = true;
		return;
	}
	button.hidden = false;
	button.onclick = () => void loginFlow(button);
}

// Sign in with a passkey: options -> navigator.credentials.get() -> verify.
// On success the hub sets the same cookie as the password; the caller then
// runs the normal post-login route.
async function loginFlow(button) {
	const err = document.getElementById("login-error");
	if (err) err.textContent = "";
	button.disabled = true;
	try {
		const { options, token } = await api.passkeyLoginOptions();
		const assertion = await browser.startAuthentication({ optionsJSON: options });
		await api.passkeyLogin(assertion, token);
		// Same post-login path as the password form (main.mjs wires both here).
		passkeyLoginSuccess?.();
	} catch (e) {
		const msg = /NotAllowedError/i.test(String(e?.name))
			? "Passkey cancelled."
			: e?.message || "Passkey login failed.";
		if (err) err.textContent = msg;
		else toast(msg, "error");
	} finally {
		button.disabled = false;
	}
}

// Set by main.mjs: the post-login routing (refresh registry, route, show
// dashboard). Kept here to avoid a circular import.
let passkeyLoginSuccess = null;
export function onPasskeyLoginSuccess(fn) {
	passkeyLoginSuccess = typeof fn === "function" ? fn : null;
}

// One mount at a time: dashboard re-renders fire mountBanner often, and two
// overlapping async mounts would both fetch and both append. Reuse the
// in-flight promise; later re-renders become no-ops while one is running.
let mountInFlight = null;
export function mountBanner(container) {
	if (!container || mountInFlight) return mountInFlight || Promise.resolve();
	mountInFlight = mountBannerAsync(container).finally(() => {
		mountInFlight = null;
	});
	return mountInFlight;
}

// Dashboard banner body: offer to register this device (no passkey yet) or
// manage (registered). Hidden entirely when disabled, unsupported, dismissed.
async function mountBannerAsync(container) {
	if (!container) return;
	container.replaceChildren();
	container.hidden = true;
	let st;
	try {
		st = await api.passkeyStatus();
	} catch {
		return;
	}
	if (!st.enabled || !supported()) return;

	if (!st.registered) {
		if (localStorage.getItem(DISMISS_KEY) === "1") return;
		const note = document.createElement("span");
		note.className = "dim small";
		note.textContent = "Unlock with Face ID next time?";
		const add = document.createElement("button");
		add.className = "btn small";
		add.type = "button";
		add.textContent = "Add Face ID";
		add.addEventListener("click", () => void registerFlow(add));
		const dismiss = document.createElement("button");
		dismiss.className = "btn icon";
		dismiss.type = "button";
		dismiss.setAttribute("aria-label", "Dismiss");
		dismiss.textContent = "×";
		dismiss.addEventListener("click", () => {
			localStorage.setItem(DISMISS_KEY, "1");
			container.replaceChildren();
			container.hidden = true;
		});
		container.append(note, add, dismiss);
		container.hidden = false;
		return;
	}

	// Registered: small management row (remove). Collapsed by default so it
	// does not fight the session list for space.
	const note = document.createElement("span");
	note.className = "dim small";
	note.textContent = "Face ID unlock is active.";
	const remove = document.createElement("button");
	remove.className = "btn small";
	remove.type = "button";
	remove.textContent = "Remove all";
	remove.addEventListener("click", async () => {
		if (remove.dataset.confirm !== "1") {
			remove.dataset.confirm = "1";
			remove.textContent = "Remove on every device?"; // no id is sent: all go
			return;
		}
		try {
			await api.passkeyDelete();
			toast("Passkey removed", "info");
			localStorage.removeItem(DISMISS_KEY);
			await mountBanner(container);
		} catch (e) {
			toast(e.message, "error");
		}
	});
	container.append(note, remove);
	container.hidden = false;
}

// Add this device's passkey: options -> navigator.credentials.create() ->
// verify. Requires the current password session (the hub enforces it).
async function registerFlow(button) {
	button.disabled = true;
	try {
		const { options, token } = await api.passkeyRegisterOptions();
		const attestation = await browser.startRegistration({ optionsJSON: options });
		await api.passkeyRegister(attestation, token);
		toast("Face ID unlock added — use it on the next sign-in", "info");
		localStorage.removeItem(DISMISS_KEY);
		await mountBanner(document.getElementById("passkey-banner"));
	} catch (e) {
		const msg = /InvalidStateError/i.test(String(e?.name))
			? "This device already has a passkey on the hub."
			: /NotAllowedError/i.test(String(e?.name))
				? "Passkey setup cancelled."
				: e?.message || "Passkey setup failed.";
		toast(msg, "error");
	} finally {
		button.disabled = false;
	}
}
