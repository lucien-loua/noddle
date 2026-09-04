#!/usr/bin/env bash

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

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  TARGET_USER="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required (or run as root)."
  SUDO="sudo"
  TARGET_USER="$USER"
fi

say "Docker"
if command -v docker >/dev/null 2>&1; then
  echo "already present: $(docker --version)"
else
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO usermod -aG docker "$TARGET_USER" || true
fi

docker compose version >/dev/null 2>&1 \
  || die "the docker compose plugin is missing — install docker-compose-plugin."

SWARM_STATE="$($SUDO docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown)"
if [ "$SWARM_STATE" != "active" ]; then
  say "Enabling Swarm"
  $SUDO docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')"
else
  echo "Swarm already active"
fi

$SUDO docker network create --driver=overlay --attachable "$NETWORK" 2>/dev/null \
  && echo "network $NETWORK created" \
  || echo "network $NETWORK already there"

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

say "Secrets"
ENV_FILE="$NODDLE_DIR/installer/.env"

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
  $SUDO tee "$ENV_FILE" >/dev/null <<EOF
APP_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
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

ensure_env REDIS_PASSWORD "$(openssl rand -hex 24)"
ensure_env NODDLE_DOMAIN "${NODDLE_DOMAIN:-}"
ensure_env ACME_EMAIL "${ACME_EMAIL:-}"
ensure_env ACME_CASERVER "${ACME_CASERVER:-}"

say "SSH access to this machine"
$SUDO mkdir -p "$SSH_DIR"
$SUDO chmod 700 "$SSH_DIR"
if $SUDO test -f "$SSH_KEY"; then
  echo "key already present"
else
  $SUDO ssh-keygen -t ed25519 -N "" -C "noddle@$(hostname)" -f "$SSH_KEY" -q
  echo "pair generated"
fi

HOST_IP="${HOST_IP:-$(hostname -I | awk '{print $1}')}"

HOST_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -n "$HOST_HOME" ] || die "could not find the home directory of $TARGET_USER"
$SUDO mkdir -p "$HOST_HOME/.ssh"
$SUDO chmod 700 "$HOST_HOME/.ssh"
PUBKEY="$($SUDO cat "$SSH_KEY.pub")"

SSH_FROM="127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,$HOST_IP"
AUTH_FILE="$HOST_HOME/.ssh/authorized_keys"
AUTH_LINE="from=\"$SSH_FROM\" $PUBKEY"

$SUDO touch "$AUTH_FILE"
if $SUDO grep -qxF "$AUTH_LINE" "$AUTH_FILE"; then
  echo "already authorized for $TARGET_USER"
else
  $SUDO sed -i "\|$PUBKEY|d" "$AUTH_FILE"
  echo "$AUTH_LINE" | $SUDO tee -a "$AUTH_FILE" >/dev/null
  $SUDO chmod 600 "$AUTH_FILE"
  $SUDO chown -R "$TARGET_USER" "$HOST_HOME/.ssh"
  echo "authorized for $TARGET_USER (sources: $SSH_FROM)"
fi

RAILPACK_VERSION=0.36.4
if ! command -v railpack >/dev/null 2>&1; then
  say "railpack $RAILPACK_VERSION"
  export RAILPACK_VERSION
  curl -sSL https://railpack.com/install.sh | $SUDO -E sh
fi

BUILDKIT_IMAGE=moby/buildkit:v0.27.0
if ! $SUDO docker image inspect "$BUILDKIT_IMAGE" >/dev/null 2>&1; then
  say "$BUILDKIT_IMAGE"
  $SUDO docker pull "$BUILDKIT_IMAGE"
fi

say "Image registry"
$SUDO mkdir -p "$REGISTRY_DIR"
$SUDO chmod 700 "$REGISTRY_DIR"

ensure_env REGISTRY_HOST "$HOST_IP:5000"
ensure_env REGISTRY_PASSWORD "$(openssl rand -hex 24)"
REGISTRY_HOST="$(read_env REGISTRY_HOST)"
REGISTRY_ADDR="${REGISTRY_HOST%:*}"

if $SUDO test -f "$REGISTRY_DIR/ca.crt" && $SUDO test -f "$REGISTRY_DIR/htpasswd"; then
  echo "CA and credentials already in place"
else

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

  printf '%s' "$(read_env REGISTRY_PASSWORD)" \
    | $SUDO docker run --rm -i httpd:2-alpine htpasswd -Bin noddle 2>/dev/null \
    | $SUDO tee "$REGISTRY_DIR/htpasswd" >/dev/null
  $SUDO docker rmi httpd:2-alpine >/dev/null 2>&1 || true

  $SUDO chmod 600 "$REGISTRY_DIR"/*
  $SUDO chmod 644 "$REGISTRY_DIR/ca.crt"
  echo "CA generated for $REGISTRY_HOST (valid for 10 years)"
fi

say "Building and starting the control plane"

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

COMPOSE=(docker compose --project-directory "$NODDLE_DIR/installer" --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")
[ -z "$SUDO" ] || COMPOSE=("$SUDO" "${COMPOSE[@]}")

NODDLE_COMMIT="$($SUDO git -C "$NODDLE_DIR" rev-parse HEAD 2>/dev/null || echo '')"
export NODDLE_COMMIT
[ -n "$NODDLE_COMMIT" ] && echo "version: ${NODDLE_COMMIT:0:12}"

"${COMPOSE[@]}" build </dev/null

"${COMPOSE[@]}" up -d --wait postgres </dev/null

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
