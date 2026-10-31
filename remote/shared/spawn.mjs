// pi-remote shared spawn — builds and runs the sandbox-parity systemd-run wrapper
// for phone-started sessions (docs/SPEC.md §6, ADR 0002). Plain ESM, zero deps.
// Runs on Node 22 (stub) and Bun inside pi (extension).
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The exact property list from ~/.config/fish/config.fish __pi_sandbox,
// minus --pty (headless) and minus the invoke dir (home base folder IS ~/.pi).

// Session kinds per ADR 0006. Strict whitelist: the kind becomes a systemd
// environment property, so anything unexpected must be refused, never coerced
// silently. Absent kind defaults to "temp" (the spawn default from the phone).
const SESSION_KINDS = ["temp", "normal"];

export function normalizeSessionKind(kind) {
  if (kind === undefined || kind === null) return "temp";
  if (SESSION_KINDS.includes(kind)) return kind;
  throw new Error(`invalid session kind: ${JSON.stringify(kind)} (expected "temp" or "normal")`);
}

export function buildSpawnArgs({ piBin, name, kind }) {
  const kind_ = normalizeSessionKind(kind);
  const home = homedir();
  const piHome = join(home, ".pi");
  const safeName = String(name || "remote session").replace(/["'\\$]/g, "");
  return [
    "--user",
    "--collect",
    "--quiet",
    `--description=pi agent sandbox (remote)`,
    // The ONLY addition to the terminal sandbox list (ADR 0002 parity):
    // the session kind, read back by the extension for delete semantics.
    `--property=Environment=PI_REMOTE_SESSION_KIND=${kind_}`,
    `--property=WorkingDirectory=${piHome}`,
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=read-only",
    `--property=ReadWritePaths=${piHome}`,
    `--property=ReadWritePaths=${join(home, ".cache")}`,
    `--property=ReadWritePaths=${join(home, ".npm")}`,
    "--property=ReadWritePaths=/tmp",
    "--property=NoNewPrivileges=yes",
    "--property=ProtectKernelTunables=yes",
    "--property=ProtectKernelModules=yes",
    "--property=ProtectControlGroups=yes",
    "--property=ProtectClock=yes",
    "--property=ProtectHostname=yes",
    "--property=RestrictSUIDSGID=yes",
    "--property=RestrictNamespaces=yes",
    "--property=LockPersonality=yes",
    "--",
    "sh",
    "-c",
    `sleep infinity | exec ${piBin} --mode rpc --name "${safeName}"`,
  ];
}

// Freshness rule replicated from the fish __pi_bolt_bin function:
// prefer the compiled copy while it is newer than the packaged one.
export function resolvePiBin() {
  const compiled = join(homedir(), ".cache", "pibolt-compiled", "pi");
  const base = "/usr/lib/pi-bolt/pi";
  try {
    if (existsSync(compiled) && existsSync(base)) {
      if (statSync(compiled).mtimeMs > statSync(base).mtimeMs) return compiled;
    }
    if (existsSync(compiled)) return compiled;
  } catch {
    /* stat failures fall through */
  }
  return base;
}

// Returns a Promise<{ ok, pid?, error? }>. Fire-and-forget by design: the
// transient unit is a sibling owned by the user manager and survives us.
export function runSpawn({ name, kind } = {}) {
  const piBin = resolvePiBin();
  const args = buildSpawnArgs({ piBin, name, kind });
  return new Promise((resolve) => {
    execFile("systemd-run", args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: String(err.message || err) + (stderr ? ` :: ${stderr}` : "") });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

// systemd availability probe: the user manager must answer.
export function systemdAvailable() {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "is-system-running"], { timeout: 5_000 }, (err, stdout) => {
      // is-system-running exits 0 (running) or 1 (degraded/starting) — both mean
      // a manager exists. Non-zero with "not found"/connection error = absent.
      if (err && err.killed) return resolve(false);
      const out = String(stdout || "").trim();
      resolve(!err || out === "running" || out === "degraded" || out === "starting");
    });
  });
}
