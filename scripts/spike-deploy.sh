#!/usr/bin/env bash
#
# Noddle — spike vertical, version locale
#
# Provisionne une VM locale qui se comporte comme un vrai VPS, puis fait
# tourner la chaîne complète dessus :
#
#   SSH → Swarm → git clone → Nixpacks → docker service create → Traefik → HTTP
#
# Pourquoi une VM et pas Docker-in-Docker : les réseaux overlay de Swarm créent
# des interfaces VXLAN même sur un seul nœud. En DinD ça marche "généralement",
# et quand ça ne marche pas tu perds deux jours sur un problème qui n'existe pas
# en production. Une vraie VM a un vrai systemd, un vrai stack réseau, un vrai
# chemin d'installation Docker. C'est la même chose qu'un VPS, en gratuit.
#
# Prérequis :
#   multipass  (https://multipass.run — macOS, Linux, Windows)
#   une clé SSH publique dans ~/.ssh/
#
# Usage :
#   ./spike-local.sh          # provisionne + déploie
#   ./spike-local.sh reset    # détruit la VM et recommence
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
SAMPLE_REPO="${SAMPLE_REPO:-https://github.com/vercel/next.js.git}"
SAMPLE_SUBDIR="${SAMPLE_SUBDIR:-examples/hello-world}"
APP_PORT="${APP_PORT:-3000}"

APP_NAME="spike-app"
TRAEFIK_NET="noddle-public"
BUILD_DIR="/opt/noddle-spike"
TAG="$(date +%s)"
BUILD_MEM="${BUILD_MEM:-1g}"
BUILD_CPUS="${BUILD_CPUS:-1.5}"

log()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# reset
# ─────────────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "reset" ]]; then
  log "Destruction de $VM_NAME"
  multipass delete "$VM_NAME" --purge 2>/dev/null || true
  echo "Fait. Relance sans argument pour repartir de zéro."
  exit 0
fi

command -v multipass >/dev/null 2>&1 || fail "multipass absent — https://multipass.run"
[[ -f "$SSH_KEY.pub" ]] || fail "Pas de clé publique à $SSH_KEY.pub (ssh-keygen -t ed25519)"

# ─────────────────────────────────────────────────────────────────────────────
# 1. VM
# ─────────────────────────────────────────────────────────────────────────────
log "1/7 · VM locale ($VM_MEM RAM, $VM_CPUS vCPU)"

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

echo "IP    : $VM_IP"
echo "Domain: $APP_DOMAIN"

VPS="ubuntu@$VM_IP"
remote() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$VPS" "$@"; }

log "Attente du SSH"
for i in {1..30}; do
  remote true 2>/dev/null && break
  [[ $i -eq 30 ]] && fail "SSH injoignable après 60s"
  sleep 2
done

# ─────────────────────────────────────────────────────────────────────────────
# 2. Docker + Swarm
# ─────────────────────────────────────────────────────────────────────────────
log "2/7 · Docker et Swarm"

remote bash -s <<'REMOTE'
set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
if ! sudo docker info 2>/dev/null | grep -q 'Swarm: active'; then
  sudo docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')"
fi
REMOTE

# ─────────────────────────────────────────────────────────────────────────────
# 3. Nixpacks
# ─────────────────────────────────────────────────────────────────────────────
log "3/7 · Nixpacks"

remote bash -s <<'REMOTE'
set -euo pipefail
if ! command -v nixpacks >/dev/null 2>&1; then
  curl -sSL https://nixpacks.com/install.sh | sudo bash
fi
nixpacks --version
REMOTE

# ─────────────────────────────────────────────────────────────────────────────
# 4. Traefik
# ─────────────────────────────────────────────────────────────────────────────
log "4/7 · Traefik"

# EN LOCAL : pas d'ACME. Let's Encrypt doit joindre ton serveur depuis
# l'internet public, ce qui est impossible ici. On route en HTTP simple.
#
# Pour exercer quand même le chemin de code ACME sans vrais certificats,
# ajoute Pebble (le serveur ACME de test de Let's Encrypt) et pointe
# --certificatesresolvers.le.acme.caserver dessus. À faire en Phase 1, pas
# maintenant — le spike valide la chaîne, pas les certificats.
remote bash -s <<REMOTE
set -euo pipefail
sudo docker network create --driver=overlay --attachable "$TRAEFIK_NET" 2>/dev/null || true

if ! sudo docker service inspect noddle-traefik >/dev/null 2>&1; then
  # Traefik v3 : le provider Swarm est séparé du provider Docker.
  # En v2 c'était --providers.docker.swarmMode=true.
  sudo docker service create \\
    --name noddle-traefik \\
    --constraint 'node.role==manager' \\
    --publish published=80,target=80,mode=host \\
    --publish published=8080,target=8080,mode=host \\
    --network "$TRAEFIK_NET" \\
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,ro \\
    traefik:v3.3 \\
      --providers.swarm=true \\
      --providers.swarm.exposedByDefault=false \\
      --providers.swarm.network="$TRAEFIK_NET" \\
      --entrypoints.web.address=:80 \\
      --api.insecure=true \\
      --log.level=INFO
fi
REMOTE

echo "Dashboard Traefik : http://$VM_IP:8080"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Clone
# ─────────────────────────────────────────────────────────────────────────────
log "5/7 · Clone"

remote bash -s <<REMOTE
set -euo pipefail
sudo rm -rf "$BUILD_DIR"
sudo mkdir -p "$BUILD_DIR"
sudo chown -R \$USER "$BUILD_DIR"
git clone --depth 1 "$SAMPLE_REPO" "$BUILD_DIR/src"
REMOTE

# ─────────────────────────────────────────────────────────────────────────────
# 6. Build capé
# ─────────────────────────────────────────────────────────────────────────────
log "6/7 · Build (mem=$BUILD_MEM cpus=$BUILD_CPUS)"

# Regarde bien comment sort ce flux. C'est exactement ce que le worker devra
# streamer en SSE. Ligne par ligne, ou par gros blocs bufferisés ? La réponse
# décide de l'implémentation des logs live.
remote bash -s <<REMOTE
set -euo pipefail
cd "$BUILD_DIR/src/$SAMPLE_SUBDIR"
sudo nixpacks build . \\
  --name "$APP_NAME:$TAG" \\
  --docker-opts "--memory=$BUILD_MEM --cpus=$BUILD_CPUS" \\
  2>&1
REMOTE

# ─────────────────────────────────────────────────────────────────────────────
# 7. Déploiement
# ─────────────────────────────────────────────────────────────────────────────
log "7/7 · docker service create / update"

remote bash -s <<REMOTE
set -euo pipefail

# En Swarm, Traefik lit les labels sur le SERVICE, pas le conteneur.
# Et loadbalancer.server.port est OBLIGATOIRE : Traefik ne peut pas
# deviner le port en mode Swarm.
LABELS=(
  --label "traefik.enable=true"
  --label "traefik.http.routers.$APP_NAME.rule=Host(\\\`$APP_DOMAIN\\\`)"
  --label "traefik.http.routers.$APP_NAME.entrypoints=web"
  --label "traefik.http.services.$APP_NAME.loadbalancer.server.port=$APP_PORT"
)

if sudo docker service inspect "$APP_NAME" >/dev/null 2>&1; then
  # Le cœur du produit : mise à jour transactionnelle. Nouvelle task saine
  # AVANT que l'ancienne ne soit drainée, rollback automatique sinon.
  sudo docker service update \\
    --image "$APP_NAME:$TAG" \\
    --update-order start-first \\
    --update-failure-action rollback \\
    --detach=false \\
    "$APP_NAME"
else
  sudo docker service create \\
    --name "$APP_NAME" \\
    --network "$TRAEFIK_NET" \\
    --replicas 1 \\
    --update-order start-first \\
    --update-failure-action rollback \\
    --health-cmd "wget -qO- http://localhost:$APP_PORT/ >/dev/null 2>&1 || exit 1" \\
    --health-interval 5s \\
    --health-retries 3 \\
    --health-start-period 20s \\
    "\${LABELS[@]}" \\
    --detach=false \\
    "$APP_NAME:$TAG"
fi
REMOTE

# ─────────────────────────────────────────────────────────────────────────────
log "Vérification"
sleep 5

if curl -fsS --max-time 15 "http://$APP_DOMAIN" >/dev/null; then
  printf '\n\033[1;32m✓ http://%s répond. Spike validé.\033[0m\n\n' "$APP_DOMAIN"
  echo "Relance le script : le second passage prend le chemin"
  echo "'docker service update' — c'est là que tu vois le zéro-downtime."
  echo
else
  printf '\n\033[1;31m✗ Pas de réponse.\033[0m\n\n'
  cat <<HINTS
  ssh -i $SSH_KEY $VPS sudo docker service logs noddle-traefik --tail 50
  ssh -i $SSH_KEY $VPS sudo docker service ps $APP_NAME --no-trunc
  Dashboard Traefik : http://$VM_IP:8080

  Suspects, dans l'ordre :
   1. Nom du provider Traefik (v3 = providers.swarm, v2 = providers.docker.swarmMode)
   2. loadbalancer.server.port manquant ou faux
   3. Service pas sur le même réseau overlay que Traefik
   4. Le build a été tué par la limite mémoire → augmente BUILD_MEM,
      mais note-le : c'est exactement le problème que Noddle doit gérer proprement
HINTS
  exit 1
fi