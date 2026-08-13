#!/usr/bin/env bash
#
# Noddle — adopte la VM locale comme serveur n°1
#
# En production, `installer/install.sh` enregistre la machine qui l'exécute
# comme serveur n°1 : l'hôte EST la cible, il n'y a rien à ajouter à la main
# (ADR-0006). En développement le plan de contrôle tourne sur ta machine et la
# cible est une VM Multipass (ADR-0016) : personne ne joue ce rôle, la base
# reste à zéro serveur, et l'interface ne peut pas rattraper le coup —
# `provision.ts` exige un manager Swarm existant pour ajouter quoi que ce soit.
#
# Ce script comble exactement ce trou, en réutilisant le MÊME `adopt-host.ts`
# que l'installeur. Rien n'est dupliqué : le chemin de dev exerce celui de la
# production.
#
# Prérequis : une VM lancée (voir `scripts/spike-local.sh`) et `apps/worker/.env`
# renseigné — DATABASE_URL et APP_KEY.
#
# Usage :
#   ./scripts/adopt-local.sh
#   VM_NAME=autre SSH_KEY=~/.ssh/autre ./scripts/adopt-local.sh
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

command -v multipass >/dev/null 2>&1 || fail "multipass absent"
[ -f "$SSH_KEY" ] || fail "clé privée absente : $SSH_KEY"
[ -f "$ENV_FILE" ] || fail "apps/worker/.env absent (DATABASE_URL et APP_KEY requis)"
[ -f "$ADOPT" ] || fail "adopt-host.ts introuvable : $ADOPT"

# `adopt-host.ts` parle à Docker via dockerode À TRAVERS le tunnel SSH, et c'est
# exactement ce que Bun ne sait pas faire (ADR-0015). Node n'est pas une
# préférence ici, c'est la seule option qui marche.
command -v node >/dev/null 2>&1 ||
  fail "node absent — adopt-host ne tourne PAS sur Bun (ADR-0015)"

VM_IP="$(multipass info "$VM_NAME" --format csv 2>/dev/null | tail -1 | cut -d, -f3)"
[ -n "$VM_IP" ] ||
  fail "VM $VM_NAME introuvable ou sans IP — lance d'abord scripts/spike-local.sh"
VPS="$HOST_USER@$VM_IP"

log "Cible : $VPS"

# La clé part en env sur la ligne de commande plutôt que par interpolation : le
# heredoc reste quoté, donc aucun échappement à gérer dedans.
log "Socle Docker et Swarm"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR "$VPS" \
  "env $(printf '%q' "VM_IP=$VM_IP") bash -euo pipefail -s" <<'REMOTE'
if command -v docker >/dev/null 2>&1; then
  echo "docker déjà installé"
else
  curl -fsSL https://get.docker.com | sudo sh
  # Le groupe est résolu à l'ouverture de session : c'est la connexion SSH
  # SUIVANTE — celle d'adopt-host — qui en bénéficiera, et c'est celle qui en
  # a besoin pour atteindre le socket.
  sudo usermod -aG docker "$USER"
fi

# Surtout PAS `docker info | grep -q`. grep -q sort au premier match, docker
# info prend un SIGPIPE (141), et `set -o pipefail` en fait un échec de
# pipeline : on relancerait `swarm init` sur un nœud déjà en swarm, par
# intermittence. On interroge l'état directement.
SWARM_STATE="$(sudo docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown)"
if [ "$SWARM_STATE" = "active" ]; then
  echo "swarm déjà actif"
else
  sudo docker swarm init --advertise-addr "$VM_IP"
fi

sudo docker version --format 'Docker {{.Server.Version}}'
REMOTE

# HOST_SSH_KEY est un CHEMIN : adopt-host lit le fichier, chiffre la clé avec
# APP_KEY et la range dans la bibliothèque, comme n'importe quelle clé saisie
# depuis l'interface.
log "Adoption comme serveur n°1"
HOST_IP="$VM_IP" \
  HOST_USER="$HOST_USER" \
  HOST_SSH_KEY="$SSH_KEY" \
  HOST_NAME="$VM_NAME" \
  node --env-file="$ENV_FILE" "$ADOPT"

printf '\n\033[32m✓ %s est le serveur n°1.\033[0m\n' "$VM_NAME"
printf '  Recharge le dashboard : la machine doit apparaître connectée.\n\n'
