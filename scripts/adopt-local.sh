#!/usr/bin/env bash
#
# Noddle — adopt the local VM as server #1
#
# In production the installer registers the machine it runs on as server #1:
# the host IS the target, there is nothing to add by hand (ADR-0006). In
# development the control plane runs on your machine and the target is a
# Multipass VM (ADR-0016), so nobody plays that role: the database sits at zero
# servers, and the interface cannot recover from it — `provision.ts` requires an
# existing Swarm manager before it will add anything.
#
# This fills that gap, reusing the SAME `adopt-host.ts` the installer calls.
# Nothing is duplicated: the development path exercises the production one.
#
# Requires a running VM (see `scripts/spike-local.sh`) and `apps/worker/.env`
# filled in — DATABASE_URL and APP_KEY.
#
# Usage:
#   ./scripts/adopt-local.sh
#   VM_NAME=other SSH_KEY=~/.ssh/other ./scripts/adopt-local.sh
#
set -euo pipefail

VM_NAME="${VM_NAME:-noddle-target-1}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
HOST_USER="${HOST_USER:-ubuntu}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/worker/.env"
ADOPT="$ROOT/apps/worker/src/target/adopt-host.ts"

log() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() {
  printf '\033[31m✗ %s\033[0m\n' "$1" >&2
  exit 1
}

command -v multipass >/dev/null 2>&1 || fail "multipass is missing"
[ -f "$SSH_KEY" ] || fail "private key missing: $SSH_KEY"
[ -f "$ENV_FILE" ] || fail "apps/worker/.env missing (DATABASE_URL and APP_KEY required)"
[ -f "$ADOPT" ] || fail "adopt-host.ts not found: $ADOPT"

# `adopt-host.ts` drives Docker through the SSH tunnel, which is exactly what
# fails on Bun (ADR-0015). Node is not a preference here, it is the only option
# that works.
command -v node >/dev/null 2>&1 ||
  fail "node is missing — adopt-host does NOT run on Bun (ADR-0015)"

VM_IP="$(multipass info "$VM_NAME" --format csv 2>/dev/null | tail -1 | cut -d, -f3)"
[ -n "$VM_IP" ] ||
  fail "VM $VM_NAME not found or has no IP — run scripts/spike-local.sh first"
VPS="$HOST_USER@$VM_IP"

log "Target: $VPS"

# The address travels as an env assignment on the ssh command line rather than
# by interpolation, so the heredoc stays quoted and needs no escaping.
log "Docker and Swarm"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR "$VPS" \
  "env $(printf '%q' "VM_IP=$VM_IP") bash -euo pipefail -s" <<'REMOTE'
if command -v docker >/dev/null 2>&1; then
  echo "docker already installed"
else
  curl -fsSL https://get.docker.com | sudo sh
  # Group membership is resolved at login, so it is the NEXT SSH connection —
  # the one adopt-host opens — that benefits, and that is the one needing the
  # socket.
  sudo usermod -aG docker "$USER"
fi

# Never `docker info | grep -q`: grep exits at the first match, docker info
# takes a SIGPIPE, and pipefail turns that into a failed pipeline — `swarm
# init` would then rerun on an already-swarmed node, intermittently. Query the
# state directly.
SWARM_STATE="$(sudo docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown)"
if [ "$SWARM_STATE" = "active" ]; then
  echo "swarm already active"
else
  sudo docker swarm init --advertise-addr "$VM_IP"
fi

sudo docker version --format 'Docker {{.Server.Version}}'
REMOTE

# HOST_SSH_KEY is a PATH: adopt-host reads the file, encrypts the key with
# APP_KEY and files it in the library, like any key entered from the interface.
log "Adopting as server #1"
HOST_IP="$VM_IP" \
  HOST_USER="$HOST_USER" \
  HOST_SSH_KEY="$SSH_KEY" \
  HOST_NAME="$VM_NAME" \
  node --env-file="$ENV_FILE" "$ADOPT"

printf '\n\033[32m✓ %s is server #1.\033[0m\n' "$VM_NAME"
printf '  Reload the dashboard: the machine should show as connected.\n\n'
