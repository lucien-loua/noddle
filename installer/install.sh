#!/usr/bin/env bash
#
# Installs Noddle on this machine, in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/lucien-loua/noddle/main/installer/install.sh | bash
#
# In order: Docker and Swarm, the shared overlay network, the secrets, an SSH
# key pair authorized on this machine, the registry CA and credentials, the
# control-plane stack, the migrations, and adopting this machine as server #1.
#
# Idempotent: rerunning it on an existing installation breaks nothing and
# regenerates no secret.

set -euo pipefail

NODDLE_DIR="${NODDLE_DIR:-/opt/noddle}"
NODDLE_REPO="${NODDLE_REPO:-https://github.com/lucien-loua/noddle.git}"
NODDLE_REF="${NODDLE_REF:-main}"
SSH_DIR="/etc/noddle/ssh"
SSH_KEY="$SSH_DIR/id_ed25519"
REGISTRY_DIR="/etc/noddle/registry"
NETWORK="noddle-public"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "Noddle installs on Linux."

# Elevate when needed rather than requiring root: `curl | bash` as root is a
# habit better left unencouraged.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  TARGET_USER="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required (or run as root)."
  SUDO="sudo"
  TARGET_USER="$USER"
fi

# ── 1. Docker ────────────────────────────────────────────────────────────────
say "Docker"
if command -v docker >/dev/null 2>&1; then
  echo "already present: $(docker --version)"
else
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO usermod -aG docker "$TARGET_USER" || true
fi

docker compose version >/dev/null 2>&1 \
  || die "the docker compose plugin is missing — install docker-compose-plugin."

# Never `docker info | grep -q`: grep exits at the first match, docker info
# takes a SIGPIPE, and pipefail turns that into a failed pipeline. It is a
# race, so `swarm init` reruns on an already-swarmed node intermittently.
SWARM_STATE="$($SUDO docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown)"
if [ "$SWARM_STATE" != "active" ]; then
  say "Enabling Swarm"
  $SUDO docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')"
else
  echo "Swarm already active"
fi

# Attachable: the control plane runs under Compose and must join the same
# network as the deployed Swarm services, or Traefik cannot reach them.
$SUDO docker network create --driver=overlay --attachable "$NETWORK" 2>/dev/null \
  && echo "network $NETWORK created" \
  || echo "network $NETWORK already there"

# ── 2. Sources ───────────────────────────────────────────────────────────────
say "Sources"
if [ -d "$NODDLE_DIR/.git" ]; then
  $SUDO git -C "$NODDLE_DIR" fetch --depth 1 origin "$NODDLE_REF"
  $SUDO git -C "$NODDLE_DIR" checkout -q FETCH_HEAD
  echo "updated in $NODDLE_DIR"
else
  command -v git >/dev/null 2>&1 || $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git
  $SUDO git clone --depth 1 --branch "$NODDLE_REF" "$NODDLE_REPO" "$NODDLE_DIR"
  echo "cloned into $NODDLE_DIR"
fi

# ── 3. Secrets ───────────────────────────────────────────────────────────────
say "Secrets"
ENV_FILE="$NODDLE_DIR/installer/.env"

# Adds a key without ever rewriting one already present. The block below only
# runs on a FIRST install, so without this a key introduced by a later version
# would never reach an existing installation, which would start with it empty.
ensure_env() {
  if $SUDO grep -qE "^$1=" "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  printf '%s=%s\n' "$1" "$2" | $SUDO tee -a "$ENV_FILE" >/dev/null
}
read_env() { $SUDO grep -E "^$1=" "$ENV_FILE" | cut -d= -f2-; }

if $SUDO test -f "$ENV_FILE"; then
  echo "kept: $ENV_FILE already exists"
else
  # APP_KEY encrypts SSH keys and environment variables at rest. Losing it
  # makes every stored secret unreadable.
  $SUDO tee "$ENV_FILE" >/dev/null <<EOF
APP_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NODDLE_URL=${NODDLE_URL:-}
# Both together, or neither: Let's Encrypt certifies a NAME, never an IP
# address. Without a domain, Noddle serves plain HTTP.
NODDLE_DOMAIN=${NODDLE_DOMAIN:-}
ACME_EMAIL=${ACME_EMAIL:-}
# Empty = the real Let's Encrypt. The staging server avoids burning the quota.
ACME_CASERVER=${ACME_CASERVER:-}
EOF
  $SUDO chmod 600 "$ENV_FILE"
  echo "generated in $ENV_FILE (back this up)"
fi

ensure_env NODDLE_DOMAIN "${NODDLE_DOMAIN:-}"
ensure_env ACME_EMAIL "${ACME_EMAIL:-}"
ensure_env ACME_CASERVER "${ACME_CASERVER:-}"

# ── 4. This machine's SSH key ────────────────────────────────────────────────
#
# This machine is registered as target server #1 and goes through the SSH
# executor like any other: no `localhost` branch anywhere.
say "SSH access to this machine"
$SUDO mkdir -p "$SSH_DIR"
$SUDO chmod 700 "$SSH_DIR"
if $SUDO test -f "$SSH_KEY"; then
  echo "key already present"
else
  $SUDO ssh-keygen -t ed25519 -N "" -C "noddle@$(hostname)" -f "$SSH_KEY" -q
  echo "pair generated"
fi

# A real IP, not `localhost`: the container does not share the host's network
# stack. Computed before the key block, which uses it — below, it is empty.
HOST_IP="${HOST_IP:-$(hostname -I | awk '{print $1}')}"

HOST_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -n "$HOST_HOME" ] || die "could not find the home directory of $TARGET_USER"
$SUDO mkdir -p "$HOST_HOME/.ssh"
$SUDO chmod 700 "$HOST_HOME/.ssh"
PUBKEY="$($SUDO cat "$SSH_KEY.pub")"

# This key is worth root, so a leaked copy must not be usable remotely.
# The private ranges are required: the worker calls from a CONTAINER, so sshd
# sees its Docker-network address, neither 127.0.0.1 nor $HOST_IP. `restrict`
# is excluded on purpose — it disables the forwarding dockerode needs to reach
# the Docker socket through the tunnel.
SSH_FROM="127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,$HOST_IP"
AUTH_FILE="$HOST_HOME/.ssh/authorized_keys"
AUTH_LINE="from=\"$SSH_FROM\" $PUBKEY"

$SUDO touch "$AUTH_FILE"
if $SUDO grep -qxF "$AUTH_LINE" "$AUTH_FILE"; then
  echo "already authorized for $TARGET_USER"
else
  # An earlier entry is replaced, not doubled. `sed` and not `grep -v` in a
  # pipe: grep exits 1 when no line remains, which pipefail would turn into a
  # failed installation.
  $SUDO sed -i "\|$PUBKEY|d" "$AUTH_FILE"
  echo "$AUTH_LINE" | $SUDO tee -a "$AUTH_FILE" >/dev/null
  $SUDO chmod 600 "$AUTH_FILE"
  $SUDO chown -R "$TARGET_USER" "$HOST_HOME/.ssh"
  echo "authorized for $TARGET_USER (sources: $SSH_FROM)"
fi

# The worker builds on the target, so this machine needs nixpacks locally.
if ! command -v nixpacks >/dev/null 2>&1; then
  say "nixpacks"
  curl -sSL https://nixpacks.com/install.sh | $SUDO bash
fi

# ── 5. Image registry ────────────────────────────────────────────────────────
#
# Embedded, like Postgres and Redis: an external registry would require a
# third-party account before the first deploy. It carries its own TLS signed
# by a CA generated here, because a public certificate is impossible on an
# installation reached by its IP. The CA is dropped on every node under
# /etc/docker/certs.d/, which the daemon re-reads per request — so trust can be
# established without restarting the daemon and cutting every task on the node.
say "Image registry"
$SUDO mkdir -p "$REGISTRY_DIR"
$SUDO chmod 700 "$REGISTRY_DIR"

# Frozen here once, then read back from the .env: this address is written into
# every `image_tag` in the deployment history. Recomputing it would make every
# past deployment lie the day `hostname -I` answers something else.
ensure_env REGISTRY_HOST "$HOST_IP:5000"
ensure_env REGISTRY_PASSWORD "$(openssl rand -hex 24)"
REGISTRY_HOST="$(read_env REGISTRY_HOST)"
REGISTRY_ADDR="${REGISTRY_HOST%:*}"

if $SUDO test -f "$REGISTRY_DIR/ca.crt" && $SUDO test -f "$REGISTRY_DIR/htpasswd"; then
  echo "CA and credentials already in place"
else
  # Only reached when the CA is absent: regenerating it would invalidate the
  # trust already dropped on every provisioned node, which carry the previous
  # one, and they would silently stop being able to pull.

  # A subjectAltName has a type: on a HOST_IP set by hand to a name, `IP:`
  # produces a certificate no client accepts.
  case "$REGISTRY_ADDR" in
    *[!0-9.]*) SAN="DNS:$REGISTRY_ADDR" ;;
    *) SAN="IP:$REGISTRY_ADDR" ;;
  esac

  $SUDO openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$REGISTRY_DIR/ca.key" -out "$REGISTRY_DIR/ca.crt" \
    -subj "/CN=Noddle Registry CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

  printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
    "$SAN" | $SUDO tee "$REGISTRY_DIR/ext.cnf" >/dev/null
  $SUDO openssl req -newkey rsa:2048 -nodes \
    -keyout "$REGISTRY_DIR/registry.key" -out "$REGISTRY_DIR/registry.csr" \
    -subj "/CN=$REGISTRY_ADDR" 2>/dev/null
  $SUDO openssl x509 -req -in "$REGISTRY_DIR/registry.csr" \
    -CA "$REGISTRY_DIR/ca.crt" -CAkey "$REGISTRY_DIR/ca.key" -CAcreateserial \
    -out "$REGISTRY_DIR/registry.crt" -days 3650 -sha256 \
    -extfile "$REGISTRY_DIR/ext.cnf" 2>/dev/null
  $SUDO rm -f "$REGISTRY_DIR/registry.csr" "$REGISTRY_DIR/ext.cnf"

  # The registry accepts only bcrypt, and nothing on a bare Ubuntu produces it
  # — htpasswd is absent, `openssl passwd -5` returns SHA-256 crypt. Docker is
  # guaranteed present by now. `-i` and never `-b`: `docker run` arguments are
  # readable in `ps` while it runs.
  printf '%s' "$(read_env REGISTRY_PASSWORD)" \
    | $SUDO docker run --rm -i httpd:2-alpine htpasswd -Bin noddle 2>/dev/null \
    | $SUDO tee "$REGISTRY_DIR/htpasswd" >/dev/null
  $SUDO docker rmi httpd:2-alpine >/dev/null 2>&1 || true

  $SUDO chmod 600 "$REGISTRY_DIR"/*
  $SUDO chmod 644 "$REGISTRY_DIR/ca.crt"
  echo "CA generated for $REGISTRY_HOST (valid for 10 years)"
fi

# ── 6. The stack ─────────────────────────────────────────────────────────────
say "Building and starting the control plane"

# Read from the .env and not from the environment: on a reinstallation the file
# is what counts, and it was kept above.
CONFIGURED_DOMAIN="$($SUDO grep -E '^NODDLE_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
CONFIGURED_EMAIL="$($SUDO grep -E '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)"

COMPOSE_FILES=(-f "$NODDLE_DIR/installer/docker-compose.yml")
if [ -n "$CONFIGURED_DOMAIN" ]; then
  [ -n "$CONFIGURED_EMAIL" ] \
    || die "NODDLE_DOMAIN is set but ACME_EMAIL is empty — Let's Encrypt requires a contact address."
  COMPOSE_FILES+=(-f "$NODDLE_DIR/installer/docker-compose.tls.yml")
  echo "HTTPS enabled for $CONFIGURED_DOMAIN"
else
  echo "plain HTTP: no domain configured (NODDLE_DOMAIN empty)"
fi

# `$SUDO` is empty when already root, and an array keeps that empty string as
# an argument: the prefix is therefore only added when it exists, or bash
# answers ": command not found".
COMPOSE=(docker compose --project-directory "$NODDLE_DIR/installer" --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")
[ -z "$SUDO" ] || COMPOSE=("$SUDO" "${COMPOSE[@]}")

# Written into both images, and probed by the update button to tell whether the
# new code is running. It cannot read HEAD off the disk instead: that checkout
# happened minutes ago, and the screen would report an update that has not
# restarted yet. Exported because both services declare it in their `args`.
NODDLE_COMMIT="$($SUDO git -C "$NODDLE_DIR" rev-parse HEAD 2>/dev/null || echo '')"
export NODDLE_COMMIT
[ -n "$NODDLE_COMMIT" ] && echo "version: ${NODDLE_COMMIT:0:12}"

"${COMPOSE[@]}" build </dev/null

# The database alone first, and healthy, before the migrations below. Starting
# everything then migrating leaves the new worker running against the old
# schema for as long as the migrations take, and it processes the queue during
# that window. `--wait` and not just `up -d`: `compose run` carries `--no-deps`
# and would fail on a database not yet ready.
"${COMPOSE[@]}" up -d --wait postgres </dev/null

# ── 7. Database and adoption ─────────────────────────────────────────────────
#
# `</dev/null` on each `compose run` is not cosmetic. The documented install is
# `curl | bash`, which feeds this script through stdin; without it, the
# subprocess inherits that stream and consumes the rest of the script, and bash
# reaches a silent end of file and exits 0 without running what remains.
say "Migrations"
"${COMPOSE[@]}" run --rm --no-deps -T worker \
  node /noddle/packages/db/src/migrate.ts </dev/null

say "Starting the control plane"
"${COMPOSE[@]}" up -d </dev/null

say "Adopting this machine as server #1"
"${COMPOSE[@]}" run --rm --no-deps -T \
  -e HOST_IP="$HOST_IP" \
  -e HOST_USER="$TARGET_USER" \
  -e HOST_SSH_KEY="$SSH_DIR/id_ed25519" \
  -e HOST_NAME="$(hostname)" \
  worker node src/target/adopt-host.ts </dev/null

printf '\n\033[32m✓ Noddle is installed.\033[0m\n\n'
if [ -n "$CONFIGURED_DOMAIN" ]; then
  printf '  Dashboard : https://%s\n' "$CONFIGURED_DOMAIN"
  printf '              (the first load waits for the certificate, a few seconds)\n'
else
  printf '  Dashboard : http://%s\n' "$HOST_IP"
fi
printf '  Secrets   : %s  (back this file up)\n' "$ENV_FILE"
printf '\n  The first screen creates the administrator account.\n\n'
