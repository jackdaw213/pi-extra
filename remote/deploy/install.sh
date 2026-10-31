#!/usr/bin/env bash
# pi-remote machine installer (docs/SPEC.md §12).
#
# Run ON THE TARGET MACHINE in a normal shell — NOT inside an agent sandbox:
# it writes ~/.pi, ~/.pi/agent and (with --units) ~/.config/systemd/user.
# Idempotent: safe to re-run; the existing machineToken and machineId are kept.
#
# usage: install.sh [--hub-url URL] [--name NAME] [--units] [--uninstall]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONFIG_DIR="$HOME/.pi/remote"
CONFIG="$CONFIG_DIR/config.json"
EXT_DIR="$HOME/.pi/agent/extensions/pi-remote"
UNIT_DIR="$HOME/.config/systemd/user"

die() { echo "install.sh: error: $*" >&2; exit 1; }
info() { echo "install.sh: $*"; }

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

# Read a string field from a JSON file. Best effort, no jq dependency.
json_field() { # json_field FILE KEY
  local file="$1" key="$2"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("node:fs");
      const [, file, key] = process.argv;
      try {
        const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
        const v = cfg[key];
        if (typeof v === "string" && v) process.stdout.write(v);
      } catch {}
    ' "$file" "$key" 2>/dev/null || true
  else
    sed -n "s/^.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*$/\1/p" "$file" 2>/dev/null | head -n 1 || true
  fi
}

gen_token() { # 64 hex chars
  if command -v node >/dev/null 2>&1; then
    node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    return 1
  fi
}

gen_id() { # 32 hex chars, /etc/machine-id format
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  elif command -v node >/dev/null 2>&1; then
    node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))'
  else
    return 1
  fi
}

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# --- flags -------------------------------------------------------------------
HUB_URL_FLAG=""
NAME_FLAG=""
WITH_UNITS=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hub-url) [ $# -ge 2 ] || die "--hub-url requires a value"; HUB_URL_FLAG="$2"; shift 2 ;;
    --hub-url=*) HUB_URL_FLAG="${1#--hub-url=}"; shift ;;
    --name) [ $# -ge 2 ] || die "--name requires a value"; NAME_FLAG="$2"; shift 2 ;;
    --name=*) NAME_FLAG="${1#--name=}"; shift ;;
    --units) WITH_UNITS=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

# --- uninstall ---------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  info "uninstalling pi-remote from this machine"
  systemctl --user disable --now pi-remote.socket 2>/dev/null || true
  rm -f "$UNIT_DIR/pi-remote.socket" "$UNIT_DIR/pi-remote.service"
  systemctl --user daemon-reload 2>/dev/null || true
  rm -rf "$EXT_DIR"
  rm -rf "$CONFIG_DIR"
  info "removed: $CONFIG_DIR (config, stub, inbox), $EXT_DIR, user units"
  info "also delete this machine's token line from the hub tokens file (/data/tokens in the hub container)."
  exit 0
fi

# --- sanity ------------------------------------------------------------------
for path in "$ROOT/extension" "$ROOT/shared" "$ROOT/stub/stub.mjs" \
            "$ROOT/deploy/units/pi-remote.socket" "$ROOT/deploy/units/pi-remote.service"; do
  [ -e "$path" ] || die "missing $path — run this from a full pi-remote checkout"
done
if ! command -v node >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then
  die "need node or openssl to generate the machineToken"
fi

# --- resolve config values (preserve existing on re-run) ---------------------
OLD_HUB="$(json_field "$CONFIG" hubUrl)"
OLD_TOKEN="$(json_field "$CONFIG" machineToken)"
OLD_ID="$(json_field "$CONFIG" machineId)"
OLD_NAME="$(json_field "$CONFIG" name)"

HUB_URL="${HUB_URL_FLAG:-${OLD_HUB:-}}"
if [ -z "$HUB_URL" ]; then
  die "--hub-url is required (no existing config with hubUrl at $CONFIG)"
fi
case "$HUB_URL" in
  ws://*|wss://*) : ;;
  *) echo "install.sh: warning: hubUrl should start with ws:// or wss:// — got: $HUB_URL" >&2 ;;
esac

MACHINE_TOKEN="${OLD_TOKEN:-}"
if [ -z "$MACHINE_TOKEN" ]; then
  MACHINE_TOKEN="$(gen_token)" || die "cannot generate machineToken"
fi

MACHINE_ID="${OLD_ID:-}"
if [ -z "$MACHINE_ID" ] && [ -r /etc/machine-id ] && [ -s /etc/machine-id ]; then
  MACHINE_ID="$(tr -d '[:space:]' < /etc/machine-id)"
fi
if [ -z "$MACHINE_ID" ]; then
  MACHINE_ID="$(gen_id)" || die "cannot determine machineId (no /etc/machine-id, no node/openssl)"
fi

MACHINE_NAME="${NAME_FLAG:-${OLD_NAME:-}}"

# --- write config (mode 600) --------------------------------------------------
mkdir -p "$CONFIG_DIR"
if command -v node >/dev/null 2>&1; then
  PR_CONFIG="$CONFIG" PR_HUB_URL="$HUB_URL" PR_TOKEN="$MACHINE_TOKEN" \
  PR_MACHINE_ID="$MACHINE_ID" PR_NAME="$MACHINE_NAME" \
  node -e '
    const fs = require("node:fs");
    const cfg = {
      hubUrl: process.env.PR_HUB_URL,
      machineToken: process.env.PR_TOKEN,
      machineId: process.env.PR_MACHINE_ID,
    };
    if (process.env.PR_NAME) cfg.name = process.env.PR_NAME;
    fs.writeFileSync(process.env.PR_CONFIG, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  '
else
  name_part=""
  [ -n "$MACHINE_NAME" ] && name_part="$(printf ', "name": "%s"' "$(esc "$MACHINE_NAME")")"
  printf '{ "hubUrl": "%s", "machineToken": "%s", "machineId": "%s"%s }\n' \
    "$(esc "$HUB_URL")" "$(esc "$MACHINE_TOKEN")" "$(esc "$MACHINE_ID")" "$name_part" > "$CONFIG"
fi
chmod 600 "$CONFIG"

# --- copy extension + vendored shared/ ---------------------------------------
info "installing extension to $EXT_DIR"
rm -rf "$EXT_DIR"
mkdir -p "$(dirname "$EXT_DIR")"
cp -a "$ROOT/extension" "$EXT_DIR"
rm -rf "$EXT_DIR/shared"
cp -a "$ROOT/shared" "$EXT_DIR/shared"

# --- copy cold-start stub + shared/ -------------------------------------------
info "installing cold-start stub to $CONFIG_DIR"
rm -rf "$CONFIG_DIR/shared"
cp -a "$ROOT/stub/stub.mjs" "$CONFIG_DIR/stub.mjs"
cp -a "$ROOT/shared" "$CONFIG_DIR/shared"
chmod 700 "$CONFIG_DIR"
chmod 644 "$CONFIG_DIR/stub.mjs" "$CONFIG_DIR/shared/"*.mjs

# --- optional systemd user units ----------------------------------------------
if [ "$WITH_UNITS" -eq 1 ]; then
  info "installing systemd user units to $UNIT_DIR"
  mkdir -p "$UNIT_DIR"
  cp -a "$ROOT/deploy/units/pi-remote.socket" "$UNIT_DIR/pi-remote.socket"
  cp -a "$ROOT/deploy/units/pi-remote.service" "$UNIT_DIR/pi-remote.service"
  systemctl --user daemon-reload
  systemctl --user enable --now pi-remote.socket
  info "pi-remote.socket listening on 0.0.0.0:8788 (cold start armed)"
else
  info "systemd units not installed (pass --units to arm cold start)"
fi

if [ ! -x /usr/bin/node ] && command -v node >/dev/null 2>&1; then
  echo "install.sh: warning: /usr/bin/node missing (units expect it); node is at $(command -v node)" >&2
fi

# --- summary -------------------------------------------------------------------
echo
echo "======================================================================="
echo " machineToken — add to the hub tokens file (/data/tokens), one per line:"
echo
echo "     $MACHINE_TOKEN"
echo
echo " on the hub host, e.g.:"
echo "     docker compose exec hub sh -c 'echo $MACHINE_TOKEN >> /data/tokens'"
echo "======================================================================="
echo
info "hubUrl    : $HUB_URL"
info "machineId : $MACHINE_ID"
info "config    : $CONFIG (mode 600)"
info "extension : $EXT_DIR (loads on the next pi session start)"
info "stub      : $CONFIG_DIR/stub.mjs (port 8788, socket-activated)"
echo
echo "next: start or restart a pi session on this machine; it registers with"
echo "the hub and appears on the dashboard."
