#!/usr/bin/env bash
#
# Noddle — spike vertical, version locale
#
# Provisionne une VM locale qui se comporte comme un vrai VPS, puis fait
# tourner la chaîne complète dessus :
#
#   SSH → Swarm → git clone → Nixpacks → build capé → docker service → Traefik → HTTP
#
# Pourquoi une VM et pas Docker-in-Docker : les réseaux overlay de Swarm créent
# des interfaces VXLAN même sur un seul nœud. En DinD ça marche "généralement",
# et quand ça ne marche pas tu perds deux jours sur un problème qui n'existe pas
# en production. Une vraie VM a un vrai systemd, un vrai stack réseau, un vrai
# chemin d'installation Docker. C'est la même chose qu'un VPS, en gratuit.
#
# Le spike ne valide PAS le chemin heureux. Les deux différenciateurs de Noddle
# sont des comportements d'échec :
#
#   - un déploiement cassé ne doit pas tuer la version qui tourne  → mode `break`
#   - un build gourmand ne doit pas affamer les services qui tournent → mode `cap`
#
# Tant que ces deux modes ne passent pas, la Phase 0 n'est pas finie.
#
# Prérequis :
#   multipass  (https://multipass.run — macOS, Linux, Windows)
#   une clé SSH publique dans ~/.ssh/
#
# Usage :
#   ./spike-local.sh              # provisionne + déploie (create au 1er passage,
#                                 # update au 2e — c'est là qu'on voit le zéro-downtime)
#   ./spike-local.sh break        # déploie une image cassée, vérifie que l'ancienne sert toujours
#   ./spike-local.sh break crash  # variante : passe le healthcheck puis meurt
#   ./spike-local.sh cap          # build gourmand, vérifie que le cap tient et que le service survit
#   ./spike-local.sh status       # état du service et des tasks
#   ./spike-local.sh reset        # détruit la VM et recommence
#
set -euo pipefail

VM_NAME="${VM_NAME:-noddle-target-1}"

# 2 Go volontairement. C'est la taille d'un VPS bon marché, et c'est ce qui te
# permet de reproduire pour de vrai le scénario OOM contre lequel l'archi est
# conçue. Si tu mets 8 Go, tu ne testes pas la contrainte qui compte.
VM_MEM="${VM_MEM:-2G}"
VM_DISK="${VM_DISK:-20G}"
VM_CPUS="${VM_CPUS:-2}"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
APP_PORT="${APP_PORT:-3000}"

APP_NAME="spike-app"
TRAEFIK_NET="noddle-public"

# Épinglé au patch près, volontairement. Traefik < 3.6 embarque un SDK Docker
# figé sur l'API 1.24, que Docker Engine 29 refuse (min 1.40) : le provider
# swarm ne se connecte jamais et tout répond 404 sans le moindre symptôme
# ailleurs. Corrigé en 3.6 (traefik/traefik#12253).
# Vérifier la tag sur Docker Hub, pas dans les releases GitHub : v3.7.10 est
# publiée côté GitHub sans image correspondante sur le Hub.
TRAEFIK_IMAGE="${TRAEFIK_IMAGE:-traefik:v3.7.9}"
WORK="/opt/noddle-spike"
BUILDER="noddle-builder"

# Cap du build. 1 Go sur une VM de 2 Go : il reste de quoi faire tourner les
# services pendant qu'un build tourne. C'est la valeur que le produit devra
# dériver de la capacité du serveur.
BUILD_MEM="${BUILD_MEM:-1g}"
BUILD_CPU_QUOTA="${BUILD_CPU_QUOTA:-150000}"   # 1.5 vCPU avec period=100000
BUILD_CPU_PERIOD="${BUILD_CPU_PERIOD:-100000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"

log()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

MODE="${1:-deploy}"

# ─────────────────────────────────────────────────────────────────────────────
# reset
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "reset" ]]; then
  log "Destruction de $VM_NAME"
  multipass delete "$VM_NAME" --purge 2>/dev/null || true
  echo "Fait. Relance sans argument pour repartir de zéro."
  exit 0
fi

command -v multipass >/dev/null 2>&1 || fail "multipass absent — brew install --cask multipass"
[[ -f "$SSH_KEY.pub" ]] || fail "Pas de clé publique à $SSH_KEY.pub (ssh-keygen -t ed25519)"
[[ -d "$FIXTURES/app" ]] || fail "Fixtures manquantes à $FIXTURES"

# ─────────────────────────────────────────────────────────────────────────────
# VM
# ─────────────────────────────────────────────────────────────────────────────
log "VM locale ($VM_MEM RAM, $VM_CPUS vCPU)"

if multipass info "$VM_NAME" >/dev/null 2>&1; then
  echo "$VM_NAME existe déjà."
else
  # cloud-init injecte ta clé publique. On veut du VRAI SSH, pas
  # `multipass exec` — c'est le chemin d'accès que Noddle utilisera en prod,
  # donc c'est celui qu'il faut valider.
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
[[ -n "$VM_IP" ]] || fail "Impossible de récupérer l'IP de la VM"

# sslip.io résout n'importe quel sous-domaine vers l'IP encodée dedans.
# Pas de /etc/hosts à éditer, et le routage par Host de Traefik est testé
# pour de vrai.
APP_DOMAIN="$APP_NAME.${VM_IP//./-}.sslip.io"
VPS="ubuntu@$VM_IP"

echo "IP     : $VM_IP"
echo "Domain : $APP_DOMAIN"

# Les variables partent en env sur la ligne de commande ssh plutôt que par
# interpolation dans le heredoc. Le heredoc reste quoté ('REMOTE'), donc plus
# aucun échappement de backtick ou de guillemet à gérer.
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
  "BUILD_MEM=$BUILD_MEM"
  "BUILD_CPU_QUOTA=$BUILD_CPU_QUOTA"
  "BUILD_CPU_PERIOD=$BUILD_CPU_PERIOD"
)

log "Attente du SSH"
for i in {1..30}; do
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR \
      -o ConnectTimeout=3 "$VPS" true 2>/dev/null && break
  [[ $i -eq 30 ]] && fail "SSH injoignable après 60s"
  sleep 2
done

# ─────────────────────────────────────────────────────────────────────────────
# status
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "status" ]]; then
  rexec "${BASE_ENV[@]}" <<'REMOTE'
sudo docker service ls || true
echo
sudo docker service ps "$APP_NAME" --no-trunc 2>/dev/null || echo "pas de service $APP_NAME"
echo
free -m
REMOTE
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Socle : Docker, Swarm, Nixpacks, builder capé, Traefik
# ─────────────────────────────────────────────────────────────────────────────
log "Socle (Docker, Swarm, Nixpacks, builder capé, Traefik)"

rexec "${BASE_ENV[@]}" <<'REMOTE'
# git n'est pas garanti sur une image cloud Ubuntu minimale.
if ! command -v git >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y -qq git
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

if ! sudo docker info 2>/dev/null | grep -q 'Swarm: active'; then
  sudo docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')"
fi

if ! command -v nixpacks >/dev/null 2>&1; then
  curl -sSL https://nixpacks.com/install.sh | sudo bash
fi
nixpacks --version

# ── LE CAP DU BUILD ──────────────────────────────────────────────────────────
# On ne peut PAS caper un build avec `docker build --memory` : BuildKit ignore
# purement et simplement les flags de ressources (moby/buildkit#1362,
# docker/buildx#644 propose même de les supprimer). Un cap posé là est un
# no-op silencieux — le pire des cas, parce que le build passe et tu crois
# que la protection marche.
#
# Ce qui marche : caper le BUILDER, pas la commande. Le driver docker-container
# fait tourner buildkitd dans un conteneur, et ce conteneur accepte memory /
# cpu-quota / cpu-period en --driver-opt. Le cgroup s'applique alors à tout le
# travail de build.
if ! sudo docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  sudo docker buildx create \
    --name "$BUILDER" \
    --driver docker-container \
    --driver-opt "memory=$BUILD_MEM" \
    --driver-opt "cpu-quota=$BUILD_CPU_QUOTA" \
    --driver-opt "cpu-period=$BUILD_CPU_PERIOD" \
    --bootstrap
fi
echo "Builder capé : mem=$BUILD_MEM cpu-quota=$BUILD_CPU_QUOTA/$BUILD_CPU_PERIOD"

sudo docker network create --driver=overlay --attachable "$TRAEFIK_NET" 2>/dev/null || true

# EN LOCAL : pas d'ACME. Let's Encrypt doit joindre ton serveur depuis
# l'internet public, ce qui est impossible ici. On route en HTTP simple.
# Pour exercer le chemin de code ACME sans vrais certificats : Pebble, en
# Phase 1. Le spike valide la chaîne, pas les certificats.
# Si Traefik tourne déjà sur une autre image, on le recrée. Un simple
# `service update --image` laisserait traîner l'ancienne config (env parasites
# d'un contournement abandonné, par ex.) ; pour un proxy on veut un état propre.
if sudo docker service inspect noddle-traefik >/dev/null 2>&1; then
  CURRENT_IMG="$(sudo docker service inspect noddle-traefik \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')"
  case "$CURRENT_IMG" in
    "$TRAEFIK_IMAGE"|"$TRAEFIK_IMAGE"@*) ;;
    *)
      echo "Traefik passe de $CURRENT_IMG à $TRAEFIK_IMAGE — recréation"
      sudo docker service rm noddle-traefik
      sleep 3
      ;;
  esac
fi

# NB : le contournement qui circule partout — poser DOCKER_API_VERSION sur le
# conteneur Traefik — NE MARCHE PAS. Vérifié ici : la variable est bien présente
# dans l'environnement du conteneur, celui-ci redémarre, et Traefik continue
# d'annoncer 1.24. La seule vraie correction est la version de Traefik (>= 3.6).
if ! sudo docker service inspect noddle-traefik >/dev/null 2>&1; then
  # Traefik v3 : le provider Swarm est séparé du provider Docker.
  # En v2 c'était --providers.docker.swarmMode=true.
  # timeout : avec --detach=false et une image introuvable, Swarm retente
  # indéfiniment sans jamais rendre la main.
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

echo "Dashboard Traefik : http://$VM_IP:8080"

# ─────────────────────────────────────────────────────────────────────────────
# Fixtures → VM
# ─────────────────────────────────────────────────────────────────────────────
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

  # mode.txt est écrit AVANT le commit et le build : le comportement est gravé
  # dans l'image, pas injecté à l'exécution. Un mauvais déploiement doit être
  # une mauvaise image.
  rexec "${BASE_ENV[@]}" "NAME=$name" "APP_MODE=$app_mode" <<'REMOTE'
cd "$WORK/fixtures/$NAME"
echo "$APP_MODE" > mode.txt

# On passe par un vrai git clone : c'est un maillon de la chaîne que le worker
# fera en Phase 1, autant l'exercer maintenant.
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

  # Regarde bien comment sort ce flux : c'est exactement ce que le worker devra
  # streamer en SSE. --progress=plain force un rendu ligne par ligne au lieu du
  # renderer TTY de buildx, qui réécrit l'écran et est inexploitable en stream.
  rexec "${BASE_ENV[@]}" "NAME=$name" "TAG=$tag" <<'REMOTE'
cd "$WORK/src-$NAME"

# Nixpacks n'a PAS de --docker-opts (seulement --docker-host / --docker-tls-verify
# / --docker-cert-path). On sépare donc les deux étapes : Nixpacks génère le
# Dockerfile, buildx le construit avec le builder capé.
#
# `--out .` et pas `--out ailleurs/` : nixpacks n'écrit QUE le répertoire
# .nixpacks/ (Dockerfile, build.sh, le .nix), il NE COPIE PAS les sources. Or le
# Dockerfile généré fait `COPY .nixpacks/nixpkgs-<hash>.nix ...`, donc .nixpacks
# doit se trouver À L'INTÉRIEUR du contexte de build. En sortant ailleurs, le
# contexte ne contient pas les sources et le COPY échoue sur un fichier
# introuvable.
#
# NE JAMAIS passer --apt ni --pkgs ici. Sur nixpacks 1.41.0 ces deux flags
# écrasent la liste d'overlays nix générée. Or le provider Node y déclare
# railwayapp/nix-npm-overlay, qui est ce qui DÉFINIT npm-9_x. Sans l'overlay :
#
#   error: undefined variable 'npm-9_x'
#
# et tout build Node échoue. Injecter l'overlay à la main via nixpacks.toml ne
# rattrape rien : --apt l'écrase quand même. Il n'existe donc aucun moyen
# d'injecter un paquet par la CLI nixpacks — le healthcheck ne doit dépendre
# d'aucune injection (voir deploy_image : on utilise curl, déjà dans l'image).
rm -rf .nixpacks
nixpacks build . --out .

[[ -f .nixpacks/Dockerfile ]] || { echo "nixpacks n'a pas généré .nixpacks/Dockerfile"; exit 1; }

sudo docker buildx build \
  --builder "$BUILDER" \
  --progress=plain \
  --load \
  -f .nixpacks/Dockerfile \
  -t "$APP_NAME:$TAG" \
  .
REMOTE
}

deploy_image() {
  local tag="$1"

  rexec "${BASE_ENV[@]}" "TAG=$tag" <<'REMOTE'
# En Swarm, Traefik lit les labels sur le SERVICE, pas le conteneur.
# Et loadbalancer.server.port est OBLIGATOIRE : Traefik ne peut pas deviner
# le port en mode Swarm.
RULE="Host(\`$APP_DOMAIN\`)"

# --no-resolve-image : l'image n'existe qu'en local, pas dans un registre.
# Sans ce flag Swarm tente de résoudre le digest auprès d'un registre, échoue,
# gueule, et finit par utiliser le tag. Ça marche, mais c'est lent et bruyant.
# (Et ça devient un vrai blocage le jour du multi-nœud : un autre nœud ne peut
# pas tirer une image qui n'existe que sur celui-ci.)
if sudo docker service inspect "$APP_NAME" >/dev/null 2>&1; then
  # Le cœur du produit : mise à jour transactionnelle. Nouvelle task saine
  # AVANT que l'ancienne ne soit drainée, rollback automatique sinon.
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
  timeout 300 sudo docker service create \
    --name "$APP_NAME" \
    --network "$TRAEFIK_NET" \
    --replicas 1 \
    --no-resolve-image \
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

# sslip.io renvoie une IP privée. Certains résolveurs (box, DNS d'entreprise)
# la filtrent au titre de la protection anti-DNS-rebinding. Dans ce cas on
# retombe sur un Host header explicite : le routage Traefik est testé
# pareillement, seule la résolution DNS change.
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
  Dashboard Traefik : http://$VM_IP:8080

  Suspects, dans l'ordre :
   1. Nom du provider Traefik (v3 = providers.swarm, v2 = providers.docker.swarmMode)
   2. loadbalancer.server.port manquant ou faux
   3. Service pas sur le même réseau overlay que Traefik
   4. Binaire du healthcheck absent de l'image → la task ne converge jamais et
      ça ressemble à un problème de routage. Vérifié dans l'image de base
      nixpacks:ubuntu : curl OUI (/bin/curl), wget NON, node PAS dans le PATH
      d'un shell non-login — or HEALTHCHECK tourne en sh -c non-login.
HINTS
}

# ─────────────────────────────────────────────────────────────────────────────
# MODE cap — le build gourmand ne doit pas emporter les services qui tournent
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "cap" ]]; then
  log "Test du cap de build"

  BEFORE="$(http_body || true)"
  if [[ -z "$BEFORE" ]]; then
    warn "Aucun service ne tourne. Lance d'abord ./spike-local.sh, sinon ce test"
    warn "ne prouve que la moitié de ce qui compte (le build meurt, mais on ne"
    warn "vérifie pas qu'il n'a rien emporté avec lui)."
  else
    echo "Sert actuellement : $BEFORE"
  fi

  push_fixture "$FIXTURES/hog" hog healthy
  log "Build gourmand sous cap $BUILD_MEM — il DOIT mourir"

  set +e
  build_image hog "hog-$(date +%s)"
  BUILD_RC=$?
  set -e

  echo
  if [[ $BUILD_RC -eq 0 ]]; then
    fail "Le build gourmand a RÉUSSI. Le cap ne s'applique pas — vérifie que le
    builder '$BUILDER' utilise bien le driver docker-container et que les
    --driver-opt sont pris en compte :
      ssh -i $SSH_KEY $VPS sudo docker buildx inspect $BUILDER
      ssh -i $SSH_KEY $VPS sudo docker inspect buildx_buildkit_${BUILDER}0 --format '{{.HostConfig.Memory}}'"
  fi
  ok "Le build a été tué (code $BUILD_RC) — le cap tient."

  if [[ -n "$BEFORE" ]]; then
    AFTER="$(http_body || true)"
    [[ "$AFTER" == "$BEFORE" ]] \
      && ok "Le service tournait avant et répond toujours à l'identique. C'est LE comportement." \
      || fail "Le service a été affecté par le build.
    avant : $BEFORE
    après : ${AFTER:-<aucune réponse>}"
  fi
  echo
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# MODE break — un déploiement cassé ne doit pas tuer la version qui tourne
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "break" ]]; then
  BREAK_MODE="${2:-unhealthy}"
  log "Test du déploiement cassé (mode=$BREAK_MODE)"

  BEFORE="$(http_body || true)"
  [[ -n "$BEFORE" ]] || fail "Rien ne tourne. Lance d'abord ./spike-local.sh — ce test
  vérifie que l'ANCIENNE version survit, il lui en faut une."
  echo "Sert actuellement : $BEFORE"

  TAG="broken-$(date +%s)"
  push_fixture "$FIXTURES/app" app "$BREAK_MODE"
  build_image app "$TAG"

  log "Déploiement de l'image cassée — Swarm doit refuser de basculer"
  set +e
  deploy_image "$TAG"
  DEPLOY_RC=$?
  set -e

  echo
  sleep 5
  AFTER="$(http_body || true)"

  if [[ "$BREAK_MODE" == "unhealthy" ]]; then
    [[ $DEPLOY_RC -ne 0 ]] \
      && ok "docker service update a échoué (code $DEPLOY_RC) — le health gate a fait son travail." \
      || warn "L'update a retourné 0. Vérifie le rollback dans docker service ps."

    if [[ "$AFTER" == "$BEFORE" ]]; then
      ok "L'ancienne version sert toujours, à l'identique : $AFTER"
      echo
      ok "PHASE 0 — critère de sortie n°1 validé : un déploiement cassé ne coupe rien."
    else
      fail "Le service a changé ou est tombé.
    avant : $BEFORE
    après : ${AFTER:-<aucune réponse>}
    C'est exactement le mode d'échec que toute l'architecture existe pour éviter."
    fi
  else
    # crash : la task passe le healthcheck, l'update réussit, PUIS le conteneur
    # meurt. On vérifie que Swarm le relance et que le service se rétablit.
    echo "Update terminé (code $DEPLOY_RC). Attente du crash simulé (25 s)…"
    sleep 35
    RECOVERED="$(http_body || true)"
    [[ -n "$RECOVERED" ]] \
      && ok "Le service répond encore après le crash — Swarm a relancé la task." \
      || fail "Le service est mort et n'est pas revenu. Regarde la restart policy :
    ssh -i $SSH_KEY $VPS sudo docker service ps $APP_NAME --no-trunc"
  fi

  echo
  rexec "${BASE_ENV[@]}" <<'REMOTE'
sudo docker service ps "$APP_NAME" --no-trunc | head -8
REMOTE
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# MODE deploy (défaut)
# ─────────────────────────────────────────────────────────────────────────────
TAG="$(date +%s)"

log "Fixture + clone"
push_fixture "$FIXTURES/app" app healthy

log "Build (cap mem=$BUILD_MEM)"
build_image app "$TAG"

log "docker service create / update"
deploy_image "$TAG"

log "Vérification"
sleep 5

if BODY="$(http_body)"; then
  printf '\n\033[1;32m✓ http://%s répond.\033[0m\n' "$APP_DOMAIN"
  echo "  $BODY"
  cat <<NEXT

Ensuite, dans l'ordre :

  ./spike-local.sh          relance — cette fois c'est le chemin
                            'docker service update', là où le zéro-downtime
                            est observable
  ./spike-local.sh break    déploie une image cassée : l'ancienne doit survivre
  ./spike-local.sh cap      build gourmand : les services doivent survivre

Le chemin heureux ne prouve rien. Les deux derniers, si.
NEXT
else
  printf '\n\033[1;31m✗ Pas de réponse.\033[0m\n'
  diagnose
  exit 1
fi
