// Seam: shared/spawn.mjs buildSpawnArgs — sandbox parity (ADR 0002) with a
// session-kind environment property (ADR 0006).
//
// The BASE_ARGS snapshot below was captured from buildSpawnArgs BEFORE the
// kind property existed (git 7a21422). It is the independent source of truth:
// everything except the kind property must stay byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs } from "../shared/spawn.mjs";

const PI_BIN = "/usr/lib/pi-bolt/pi";

const BASE_ARGS = [
  "--user",
  "--collect",
  "--quiet",
  "--description=pi agent sandbox (remote)",
  "--property=WorkingDirectory=/home/jackdaw/.pi",
  "--property=ProtectSystem=strict",
  "--property=ProtectHome=read-only",
  "--property=ReadWritePaths=/home/jackdaw/.pi",
  "--property=ReadWritePaths=/home/jackdaw/.cache",
  "--property=ReadWritePaths=/home/jackdaw/.npm",
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
  `sleep infinity | exec ${PI_BIN} --mode rpc --name "remote session"`,
];

function kindProperty(kind) {
  return `--property=Environment=PI_REMOTE_SESSION_KIND=${kind}`;
}

test("buildSpawnArgs injects PI_REMOTE_SESSION_KIND=temp for kind temp", () => {
  const args = buildSpawnArgs({ piBin: PI_BIN, kind: "temp" });
  assert.ok(args.includes(kindProperty("temp")), `expected env property in ${JSON.stringify(args)}`);
});

test("buildSpawnArgs injects PI_REMOTE_SESSION_KIND=normal for kind normal", () => {
  const args = buildSpawnArgs({ piBin: PI_BIN, kind: "normal" });
  assert.ok(args.includes(kindProperty("normal")));
});

test("buildSpawnArgs defaults to temp when kind is absent", () => {
  for (const absent of [undefined, null]) {
    const args = buildSpawnArgs({ piBin: PI_BIN, kind: absent });
    assert.ok(args.includes(kindProperty("temp")), `kind ${absent} must default to temp`);
  }
});

test("buildSpawnArgs rejects kinds outside the whitelist", () => {
  for (const bad of ["", "Temp", "TEMP", "throwaway", "temp ", "normal;rm", 1, {}]) {
    assert.throws(() => buildSpawnArgs({ piBin: PI_BIN, kind: bad }), Error, `kind ${JSON.stringify(bad)} must throw`);
  }
});

test("buildSpawnArgs keeps every other property byte-identical to the pre-kind list", () => {
  for (const kind of ["temp", "normal", undefined]) {
    const args = buildSpawnArgs({ piBin: PI_BIN, kind, name: "remote session" });
    // Exactly one injected env property, and the rest is byte-identical.
    const envProps = args.filter((a) => a.startsWith("--property=Environment=PI_REMOTE_SESSION_KIND="));
    assert.equal(envProps.length, 1, `exactly one kind env property for kind ${kind}`);
    const rest = args.filter((a) => !envProps.includes(a));
    assert.deepEqual(rest, BASE_ARGS);
    // And the one injected property carries exactly the expected kind.
    assert.equal(envProps[0], kindProperty(kind === undefined ? "temp" : kind));
  }
});
