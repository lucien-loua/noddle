#!/usr/bin/env bash
set -euo pipefail

VM_NAME="${VM_NAME:-noddle-target-1}"

VM_MEM="${VM_MEM:-2G}"
VM_DISK="${VM_DISK:-20G}"
VM_CPUS="${VM_CPUS:-2}"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
APP_PORT="${APP_PORT:-3000}"

APP_NAME="spike-app"
TRAEFIK_NET="noddle-public"

TRAEFIK_IMAGE="${TRAEFIK_IMAGE:-traefik:v3.7.9}"
WORK="/opt/noddle-spike"
BUILDER="noddle-builder"
BUILDKIT="noddle-buildkit"
BUILDKIT_IMAGE="${BUILDKIT_IMAGE:-moby/buildkit:v0.27.0}"

BUILD_MEM="${BUILD_MEM:-1g}"
BUILD_CPU_QUOTA="${BUILD_CPU_QUOTA:-150000}"
BUILD_CPU_PERIOD="${BUILD_CPU_PERIOD:-100000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"

log()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

MODE="${1:-deploy}"

TARGET_SSH="${TARGET_SSH:-}"

if [[ "$MODE" == "reset" ]]; then
  if [[ -n "$TARGET_SSH" ]]; then
    fail "reset refused: TARGET_SSH aims at a host this script did not create."
  fi
  log "Destroying $VM_NAME"
  multipass delete "$VM_NAME" --purge 2>/dev/null || true
  echo "Done. Run again with no argument to start from scratch."
  exit 0
fi

[[ -d "$FIXTURES/app" ]] || fail "Fixtures missing at $FIXTURES"
[[ -f "$SSH_KEY.pub" ]] || fail "No public key at $SSH_KEY.pub (ssh-keygen -t ed25519)"

if [[ -n "$TARGET_SSH" ]]; then
  VM_IP="${TARGET_IP:?TARGET_IP is required with TARGET_SSH (the reachable IP of the host)}"
  log "Pre-existing host: $TARGET_SSH"
  warn "No 2 GB cap here. CI validates the MECHANISMS and dependency drift,"
  warn "not the realism of the OOM. The local Multipass run stays the reference."
else

command -v multipass >/dev/null 2>&1 || fail "multipass missing — brew install --cask multipass"

log "Local VM ($VM_MEM RAM, $VM_CPUS vCPU)"

if multipass info "$VM_NAME" >/dev/null 2>&1; then
  echo "$VM_NAME already exists."
else
  CLOUD_INIT="$(mktemp)"
  cat > "$CLOUD_INIT" <<EOF
#cloud-config
ssh_authorized_keys:
  - $(cat "$SSH_KEY.pub")
EOF
  multipass launch 24.04 \
    --name "$VM_NAME" \
    --memory "$VM_MEM" \
    --disk "$VM_DISK" \
    --cpus "$VM_CPUS" \
    --cloud-init "$CLOUD_INIT"
  rm -f "$CLOUD_INIT"
fi

VM_IP="$(multipass info "$VM_NAME" --format csv | tail -1 | cut -d, -f3)"
fi

[[ -n "${VM_IP:-}" ]] || fail "Could not read the target machine's IP"

APP_DOMAIN="$APP_NAME.${VM_IP//./-}.sslip.io"
VPS="${TARGET_SSH:-ubuntu@$VM_IP}"
SSH_HINT="ssh -i $SSH_KEY $VPS"

echo "Target : $VPS"
echo "IP     : $VM_IP"
echo "Domain : $APP_DOMAIN"

rexec() {
  local envs=""
  local kv
  for kv in "$@"; do envs+=" $(printf '%q' "$kv")"; done
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR "$VPS" \
    "env$envs bash -euo pipefail -s"
}

BASE_ENV=(
  "APP_NAME=$APP_NAME"
  "APP_PORT=$APP_PORT"
  "APP_DOMAIN=$APP_DOMAIN"
  "TRAEFIK_NET=$TRAEFIK_NET"
  "TRAEFIK_IMAGE=$TRAEFIK_IMAGE"
  "WORK=$WORK"
  "BUILDER=$BUILDER"
  "BUILDKIT=$BUILDKIT"
  "BUILDKIT_IMAGE=$BUILDKIT_IMAGE"
  "BUILD_MEM=$BUILD_MEM"
  "BUILD_CPU_QUOTA=$BUILD_CPU_QUOTA"
  "BUILD_CPU_PERIOD=$BUILD_CPU_PERIOD"
)

log "Waiting for SSH"
for i in {1..30}; do
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR \
      -o ConnectTimeout=3 "$VPS" true 2>/dev/null && break
  [[ $i -eq 30 ]] && fail "SSH unreachable after 60s"
  sleep 2
done

if [[ "$MODE" == "status" ]]; then
  rexec "${BASE_ENV[@]}" <<'REMOTE'
sudo docker service ls || true
echo
sudo docker service ps "$APP_NAME" --no-trunc 2>/dev/null || echo "no $APP_NAME service"
echo
free -m
REMOTE
  exit 0
fi

log "Base layer (Docker, Swarm, Railpack, capped builder, Traefik)"

rexec "${BASE_ENV[@]}" <<'REMOTE'
# git is not guaranteed on a minimal Ubuntu cloud image.
if ! command -v git >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y -qq git
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# Absolutely NOT `docker info | grep -q 'Swarm: active'`. grep -q exits at the
# first match, docker info takes a SIGPIPE (141), and `set -o pipefail` turns
# that into a failed pipeline: the negation flips, and swarm init runs again on
# a node already in a swarm. Worse, it is a RACE — depending on whether docker
# info finished writing, the same code passes or breaks between runs.
# We query the state directly, with no pipe.
SWARM_STATE="$(sudo docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown)"
if [ "$SWARM_STATE" != "active" ]; then
  sudo docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')"
fi

if ! command -v railpack >/dev/null 2>&1; then
  curl -sSL https://railpack.com/install.sh | sudo sh
fi
railpack --version

# ── THE BUILD CAP ────────────────────────────────────────────────────────────
# You CANNOT cap a build with `docker build --memory`: BuildKit simply ignores
# the resource flags (moby/buildkit#1362, and docker/buildx#644 even proposes
# removing them). A cap written that way is a silent no-op — the worst case,
# because the build succeeds and you believe the protection works.
#
# What works: cap the BUILDER, not the command. The docker-container driver
# runs buildkitd inside a container, and that container accepts memory /
# cpu-quota / cpu-period as --driver-opt. The cgroup then applies to all the
# build work.
# Railpack does NOT generate a Dockerfile: it talks straight to BuildKit over
# BUILDKIT_HOST. So we run buildkitd ourselves, and that container is the one
# carrying the cgroup.
#
# buildx then attaches to it through the `remote` driver instead of creating
# its own. Two separately capped daemons would each get the whole cap: a
# Compose build beside an app build would take twice what the machine has.
# One daemon, one cgroup, every build inside it.
if ! sudo docker inspect "$BUILDKIT" >/dev/null 2>&1; then
  sudo docker run -d --privileged --restart unless-stopped \
    --name "$BUILDKIT" \
    --memory="$BUILD_MEM" \
    --cpu-quota="$BUILD_CPU_QUOTA" \
    --cpu-period="$BUILD_CPU_PERIOD" \
    "$BUILDKIT_IMAGE"
fi

# A server from before railpack already has a "$BUILDER" on the
# docker-container driver, with ITS OWN capped buildkitd. As-is, inspect
# succeeds, nothing is recreated, and the Dockerfile path keeps running on
# that second daemon: two caps on a machine sized for one. So it is the DRIVER
# that decides, not the builder existing.
BUILDER_DRIVER="$(sudo docker buildx inspect "$BUILDER" 2>/dev/null | awk '/^Driver:/ {print $2}' || true)"
if [ "$BUILDER_DRIVER" != "remote" ]; then
  [ -n "$BUILDER_DRIVER" ] && sudo docker buildx rm "$BUILDER"
  sudo docker buildx create \
    --name "$BUILDER" \
    --driver remote \
    "docker-container://$BUILDKIT"
fi

# We read the cgroup, not what the command claims to have done: this whole
# story comes from a flag that was accepted and then ignored.
echo "Builder capped: mem=$(sudo docker inspect "$BUILDKIT" --format '{{.HostConfig.Memory}}') bytes, quota=$(sudo docker inspect "$BUILDKIT" --format '{{.HostConfig.CpuQuota}}')"

sudo docker network create --driver=overlay --attachable "$TRAEFIK_NET" 2>/dev/null || true

# LOCALLY: no ACME. Let's Encrypt has to reach your server from the public
# internet, which is impossible here. We route over plain HTTP.
# To exercise the ACME code path without real certificates: Pebble, in
# Phase 1. The spike validates the chain, not the certificates.
# If Traefik is already running on another image, we recreate it. A plain
# `service update --image` would leave the old config lying around (stray env
# from an abandoned workaround, say); for a proxy we want a clean state.
if sudo docker service inspect noddle-traefik >/dev/null 2>&1; then
  CURRENT_IMG="$(sudo docker service inspect noddle-traefik \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')"
  case "$CURRENT_IMG" in
    "$TRAEFIK_IMAGE"|"$TRAEFIK_IMAGE"@*) ;;
    *)
      echo "Traefik moves from $CURRENT_IMG to $TRAEFIK_IMAGE — recreating"
      sudo docker service rm noddle-traefik
      sleep 3
      ;;
  esac
fi

# NB: the workaround that circulates everywhere — setting DOCKER_API_VERSION
# on the Traefik container — DOES NOT WORK. Verified here: the variable is
# present in the container's environment, the container restarts, and Traefik
# still announces 1.24. The only real fix is the Traefik version (>= 3.6).
if ! sudo docker service inspect noddle-traefik >/dev/null 2>&1; then
  # Traefik v3: the Swarm provider is separate from the Docker provider.
  # In v2 it was --providers.docker.swarmMode=true.
  # timeout: with --detach=false and an unreachable image, Swarm retries
  # forever without ever handing back control.
  timeout 240 sudo docker service create \
    --name noddle-traefik \
    --constraint 'node.role==manager' \
    --publish published=80,target=80,mode=host \
    --publish published=8080,target=8080,mode=host \
    --network "$TRAEFIK_NET" \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,ro \
    --detach=false \
    "$TRAEFIK_IMAGE" \
      --providers.swarm=true \
      --providers.swarm.exposedByDefault=false \
      --providers.swarm.network="$TRAEFIK_NET" \
      --entrypoints.web.address=:80 \
      --api.insecure=true \
      --log.level=INFO
fi
REMOTE

echo "Traefik dashboard: http://$VM_IP:8080"

push_fixture() {
  local src="$1" name="$2" app_mode="${3:-healthy}"

  rexec "${BASE_ENV[@]}" "NAME=$name" <<'REMOTE'
sudo mkdir -p "$WORK"
sudo chown -R "$USER" "$WORK"
rm -rf "$WORK/fixtures/$NAME" "$WORK/src-$NAME"
mkdir -p "$WORK/fixtures/$NAME"
REMOTE

  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR -q \
    "$src"/* "$VPS:$WORK/fixtures/$name/"

  rexec "${BASE_ENV[@]}" "NAME=$name" "APP_MODE=$app_mode" <<'REMOTE'
cd "$WORK/fixtures/$NAME"
echo "$APP_MODE" > mode.txt

# We go through a real git clone: it is a link in the chain the worker will
# do in Phase 1, so we may as well exercise it now.
git init -q .
git config user.email spike@noddle.local
git config user.name spike
git add -A
git commit -q -m "spike fixture $NAME mode=$APP_MODE"
git clone -q "$WORK/fixtures/$NAME" "$WORK/src-$NAME"
cd "$WORK/src-$NAME" && git rev-parse --short HEAD
REMOTE
}

build_image() {
  local name="$1" tag="$2"

  rexec "${BASE_ENV[@]}" "NAME=$name" "TAG=$tag" <<'REMOTE'
cd "$WORK/src-$NAME"

# Railpack produces no Dockerfile: it builds the LLB graph and hands it to
# BuildKit. The image lands in the Docker daemon because railpack pipes the
# `docker` exporter tarball into a `docker load` — a hardcoded binary name,
# with no sudo. Hence the `sudo -E` here, which serves TWO purposes:
#   - `docker load` then runs as a user that can reach the socket
#   - `-E` preserves BUILDKIT_HOST, without which railpack exits saying it is
#     not set. Same trap as the installer's `sudo -E`.
#
# `--output` is NOT the path to the image: it exports a filesystem.
#
# curl is FORCED into the image: railpack's Debian base does not have it, and
# the service HEALTHCHECK is a curl probe running in a non-login `sh -c`.
# Measured inside the built image: neither curl nor wget, but node present —
# the exact inverse of the nixpacks base. Without this the task never
# converges and it looks like a Traefik routing problem.
#
# The leading `...` EXTENDS the generated list; without it, it is REPLACED.
RAILPACK_BIN="$(command -v railpack)"
sudo -E env "BUILDKIT_HOST=docker-container://$BUILDKIT" \
  "$RAILPACK_BIN" build . \
    --name "$APP_NAME:$TAG" \
    --progress plain \
    --env "RAILPACK_DEPLOY_APT_PACKAGES=... curl"

# The image must be IN the daemon, not merely built.
sudo docker image inspect "$APP_NAME:$TAG" >/dev/null
REMOTE
}

deploy_image() {
  local tag="$1"

  rexec "${BASE_ENV[@]}" "TAG=$tag" <<'REMOTE'
# In Swarm, Traefik reads the labels on the SERVICE, not the container.
# And loadbalancer.server.port is REQUIRED: Traefik cannot guess the port in
# Swarm mode.
RULE="Host(\`$APP_DOMAIN\`)"

# --no-resolve-image: the image exists only locally, not in a registry.
# Without this flag Swarm tries to resolve the digest against a registry,
# fails, complains, and ends up using the tag. It works, but it is slow and
# noisy. (And it becomes a real blocker once multi-node lands: another node
# cannot pull an image that exists only on this one.)
if sudo docker service inspect "$APP_NAME" >/dev/null 2>&1; then
  # The heart of the product: a transactional update. A new healthy task
  # BEFORE the old one is drained, automatic rollback otherwise.
  timeout 300 sudo docker service update \
    --no-resolve-image \
    --image "$APP_NAME:$TAG" \
    --env-add "APP_VERSION=$TAG" \
    --update-order start-first \
    --update-failure-action rollback \
    --update-monitor 45s \
    --detach=false \
    "$APP_NAME"
else
  # --constraint: the image is LOCAL to this node. With no constraint the
  # scheduler can place the task elsewhere, where `spike-app` does not exist —
  # Swarm then tries to resolve it on Docker Hub and dies on "pull access
  # denied". Invisible while the cluster had a single node. This is what
  # `placementFor` does in the product.
  SELF_NODE_ID="$(sudo docker info --format '{{.Swarm.NodeID}}')"
  timeout 300 sudo docker service create \
    --name "$APP_NAME" \
    --network "$TRAEFIK_NET" \
    --replicas 1 \
    --no-resolve-image \
    --constraint "node.id==$SELF_NODE_ID" \
    --env "APP_VERSION=$TAG" \
    --update-order start-first \
    --update-failure-action rollback \
    --update-monitor 45s \
    --restart-condition on-failure \
    --restart-max-attempts 3 \
    --restart-window 120s \
    --health-cmd "curl -fsS -o /dev/null http://127.0.0.1:$APP_PORT/ || exit 1" \
    --health-interval 3s \
    --health-timeout 2s \
    --health-retries 3 \
    --health-start-period 5s \
    --label "traefik.enable=true" \
    --label "traefik.http.routers.$APP_NAME.rule=$RULE" \
    --label "traefik.http.routers.$APP_NAME.entrypoints=web" \
    --label "traefik.http.services.$APP_NAME.loadbalancer.server.port=$APP_PORT" \
    --detach=false \
    "$APP_NAME:$TAG"
fi
REMOTE
}

http_body() {
  curl -fsS --max-time 10 "http://$APP_DOMAIN/" 2>/dev/null && return 0
  curl -fsS --max-time 10 -H "Host: $APP_DOMAIN" "http://$VM_IP/" 2>/dev/null && return 0
  return 1
}

diagnose() {
  cat <<HINTS

  ssh -i $SSH_KEY $VPS sudo docker service logs noddle-traefik --tail 50
  ssh -i $SSH_KEY $VPS sudo docker service ps $APP_NAME --no-trunc
  ssh -i $SSH_KEY $VPS sudo docker service logs $APP_NAME --tail 50
  Traefik dashboard: http://$VM_IP:8080

  Suspects, in order:
   1. Traefik provider name (v3 = providers.swarm, v2 = providers.docker.swarmMode)
   2. loadbalancer.server.port missing or wrong
   3. Service not on the same overlay network as Traefik
   4. Healthcheck binary missing from the image → the task never converges and
      it looks like a routing problem. Measured in a railpack image
      (Debian 12 base): curl NO, wget NO, node YES (/mise/shims/node) — and
      HEALTHCHECK runs in a non-login sh -c. build_image is what forces curl
      in via RAILPACK_DEPLOY_APT_PACKAGES; check it is still there:
        ssh -i $SSH_KEY $VPS sudo docker run --rm --entrypoint /bin/sh \\
          $APP_NAME:TAG -c 'command -v curl'
HINTS
}

if [[ "$MODE" == "cap" ]]; then
  log "Build cap test"

  BEFORE="$(http_body || true)"
  if [[ -z "$BEFORE" ]]; then
    warn "No service is running. Run ./spike-local.sh first, otherwise this test"
    warn "only proves half of what matters (the build dies, but we do not check"
    warn "that it took nothing down with it)."
  else
    echo "Currently serving: $BEFORE"
  fi

  push_fixture "$FIXTURES/hog" hog healthy
  log "Hungry build under a $BUILD_MEM cap — it MUST die"

  set +e
  build_image hog "hog-$(date +%s)"
  BUILD_RC=$?
  set -e

  echo
  if [[ $BUILD_RC -eq 0 ]]; then
    fail "The hungry build SUCCEEDED. The cap is not applying — check that the
    builder '$BUILDER' really uses the docker-container driver and that the
    --driver-opt are taken into account:
      ssh -i $SSH_KEY $VPS sudo docker buildx inspect $BUILDER
      ssh -i $SSH_KEY $VPS sudo docker inspect buildx_buildkit_${BUILDER}0 --format '{{.HostConfig.Memory}}'"
  fi
  ok "The build was killed (code $BUILD_RC) — the cap holds."

  if [[ -n "$BEFORE" ]]; then
    AFTER="$(http_body || true)"
    [[ "$AFTER" == "$BEFORE" ]] \
      && ok "The service was running before and still answers identically. That is THE behaviour." \
      || fail "The service was affected by the build.
    before: $BEFORE
    after : ${AFTER:-<no response>}"
  fi
  echo
  exit 0
fi

if [[ "$MODE" == "break" ]]; then
  BREAK_MODE="${2:-unhealthy}"

  CRASH_AFTER="${3:-25}"
  MONITOR_HINT="monitor=45s"
  if [[ "$BREAK_MODE" == "crash" ]]; then
    BREAK_MODE="crash:$CRASH_AFTER"
    log "Delayed crash test (${CRASH_AFTER}s, $MONITOR_HINT)"
  else
    log "Broken deploy test (mode=$BREAK_MODE)"
  fi

  BEFORE="$(http_body || true)"
  [[ -n "$BEFORE" ]] || fail "Nothing is running. Run ./spike-local.sh first — this test
  checks that the PREVIOUS version survives, so it needs one."
  echo "Currently serving: $BEFORE"

  TAG="broken-$(date +%s)"
  push_fixture "$FIXTURES/app" app "$BREAK_MODE"
  build_image app "$TAG"

  log "Deploying the broken image — Swarm must refuse to switch over"
  set +e
  deploy_image "$TAG"
  DEPLOY_RC=$?
  set -e

  echo
  sleep 5
  AFTER="$(http_body || true)"

  if [[ "$BREAK_MODE" == "unhealthy" ]]; then
    [[ $DEPLOY_RC -ne 0 ]] \
      && ok "docker service update failed (code $DEPLOY_RC) — the health gate did its job." \
      || warn "The update returned 0. Check the rollback in docker service ps."

    if [[ "$AFTER" == "$BEFORE" ]]; then
      ok "The previous version still serves, identically: $AFTER"
      echo
      ok "PHASE 0 — exit criterion #1 validated: a broken deploy cuts nothing."
    else
      fail "The service changed or went down.
    before: $BEFORE
    after : ${AFTER:-<no response>}
    This is exactly the failure mode the whole architecture exists to avoid."
    fi
  else
    echo "Update finished (code $DEPLOY_RC). Waiting for the crash at ${CRASH_AFTER}s…"
    sleep $((CRASH_AFTER + 20))

    RECOVERED="$(http_body || true)"
    RUNNING_IMG="$(rexec "${BASE_ENV[@]}" <<'REMOTE' 2>/dev/null || true
sudo docker service inspect "$APP_NAME" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
REMOTE
)"
    UPD_STATE="$(rexec "${BASE_ENV[@]}" <<'REMOTE' 2>/dev/null || true
sudo docker service inspect "$APP_NAME" --format '{{.UpdateStatus.State}}'
REMOTE
)"
    echo "  active image: ${RUNNING_IMG:-?}"
    echo "  update state: ${UPD_STATE:-?}"

    if [[ -z "$RECOVERED" ]]; then
      fail "The service died and did not come back.
    $SSH_HINT sudo docker service ps $APP_NAME --no-trunc"
    fi

    case "$UPD_STATE" in
      rollback_completed)
        ok "Crash INSIDE the monitor window → Swarm performed a ROLLBACK (not a plain restart)."
        [[ "$RECOVERED" == "$BEFORE" ]] \
          && ok "The previous healthy version serves again: $RECOVERED" \
          || warn "The service answers but the body changed: $RECOVERED"
        ;;
      completed)
        warn "Crash AFTER the monitor window (${MONITOR_HINT}) → the update is declared successful."
        warn "There is no previous version left to restore: the restart policy relaunches"
        warn "the BROKEN IMAGE. The service may answer between two crashes — that is a"
        warn "loop, not a recovery. Currently serving: $RECOVERED"
        ;;
      *)
        warn "Unexpected update state: ${UPD_STATE:-?}. Serving: $RECOVERED"
        ;;
    esac
  fi

  echo
  rexec "${BASE_ENV[@]}" <<'REMOTE'
# `| head` closes the pipe -> SIGPIPE -> pipefail -> failure. Same trap as the
# grep -q above. We limit on the docker side instead.
sudo docker service ps "$APP_NAME" --no-trunc --filter desired-state=running
sudo docker service inspect "$APP_NAME" --format 'update: {{.UpdateStatus.State}} — {{.UpdateStatus.Message}}'
REMOTE
  exit 0
fi

TAG="$(date +%s)"

log "Fixture + clone"
push_fixture "$FIXTURES/app" app healthy

log "Build (cap mem=$BUILD_MEM)"
build_image app "$TAG"

log "docker service create / update"
deploy_image "$TAG"

log "Verification"
sleep 5

if BODY="$(http_body)"; then
  printf '\n\033[1;32m✓ http://%s answers.\033[0m\n' "$APP_DOMAIN"
  echo "  $BODY"
  cat <<NEXT

Next, in order:

  ./spike-local.sh          run again — this time it is the
                            'docker service update' path, where zero-downtime
                            is observable
  ./spike-local.sh break    deploy a broken image: the old one must survive
  ./spike-local.sh cap      hungry build: the services must survive

The happy path proves nothing. The last two do.
NEXT
else
  printf '\n\033[1;31m✗ No response.\033[0m\n'
  diagnose
  exit 1
fi
