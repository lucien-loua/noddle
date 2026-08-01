#!/usr/bin/env bash
#
# Noddle — sonde OrbStack
#
# Ne répond qu'à UNE question : est-ce qu'une machine OrbStack peut faire
# tourner Docker Swarm avec un réseau overlay et un routage Traefik ?
#
# Ce n'est pas un portage du spike. Pas de Nixpacks, pas de build, pas de
# git clone — uniquement des images préconstruites, pour que le verdict tombe
# en quelques minutes au lieu de vingt.
#
# Pourquoi cette question et pas une autre : Docker « de base » marchera
# presque certainement. Le point dur est l'overlay. Swarm crée des interfaces
# VXLAN, et les machines OrbStack partagent le noyau de la VM hôte
# (« all while sharing the same kernel », docs OrbStack). Si les modules
# noyau nécessaires manquent ou se comportent différemment, c'est là que ça
# se voit — et c'est exactement le mode d'échec contre lequel CLAUDE.md met
# en garde à propos du Docker imbriqué.
#
# Verdict attendu :
#   PASS -> OrbStack devient la boucle de dev rapide. Multipass RESTE la
#           porte avant livraison et la CI : c'est lui qui ressemble au VPS.
#   FAIL -> on garde Multipass partout, et CLAUDE.md gagne une note précise
#           au lieu d'un avertissement générique.
#
# Usage :
#   ./probe-orbstack.sh          lance la sonde
#   ./probe-orbstack.sh clean    détruit la machine de test
#
set -euo pipefail

MACHINE="${MACHINE:-noddle-orb-probe}"
MEM="${MEM:-2G}"
CPUS="${CPUS:-2}"
NET="noddle-probe-net"
APP="probe-whoami"
APP_PORT=80

pass=0
fail=0

log()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; pass=$((pass+1)); }
ko()   { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; fail=$((fail+1)); }
info() { printf '    %s\n' "$*"; }

if [[ "${1:-}" == "clean" ]]; then
  log "Suppression de $MACHINE"
  orb delete -f "$MACHINE" 2>/dev/null || true
  echo "Fait."
  exit 0
fi

command -v orb >/dev/null 2>&1 || { echo "orb absent"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
log "1. Machine ($MEM RAM, $CPUS vCPU)"
# ─────────────────────────────────────────────────────────────────────────────
if orb info "$MACHINE" >/dev/null 2>&1; then
  info "$MACHINE existe déjà"
else
  orb create ubuntu:noble "$MACHINE" --memory "$MEM" --cpus "$CPUS"
fi
orb info "$MACHINE" >/dev/null 2>&1 && ok "machine créée" || { ko "création impossible"; exit 1; }

# Vrai SSH, pas `orb run`. C'est le chemin d'accès de production, donc c'est
# celui qu'il faut exercer — même remarque que dans le spike Multipass.
# Nuance à garder en tête : OrbStack expose sa PROPRE passerelle SSH
# (localhost:32222), ce n'est pas le sshd de l'invité. Le protocole est bien
# exercé, l'installation d'OpenSSH dans la cible ne l'est pas.
remote() { ssh -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR "$MACHINE@orb" "$@"; }

log "2. Accès SSH réel"
if remote true 2>/dev/null; then
  ok "ssh $MACHINE@orb fonctionne"
  info "$(remote 'uname -sr' 2>/dev/null || echo '?')"
else
  ko "SSH injoignable — la sonde s'arrête (le reste en dépend)"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
log "3. Noyau : modules nécessaires à l'overlay"
# ─────────────────────────────────────────────────────────────────────────────
# VXLAN est le point dur. Sur noyau partagé, soit le module est là, soit
# l'overlay ne se montera jamais correctement.
remote 'bash -s' <<'EOF' || true
for m in vxlan br_netfilter overlay ip_vs; do
  if lsmod 2>/dev/null | grep -qw "^$m" || modinfo "$m" >/dev/null 2>&1; then
    echo "    disponible : $m"
  else
    echo "    ABSENT     : $m"
  fi
done
EOF

# ─────────────────────────────────────────────────────────────────────────────
log "4. Docker"
# ─────────────────────────────────────────────────────────────────────────────
remote 'bash -s' <<'EOF'
set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1
fi
sudo docker version --format 'Engine {{.Server.Version}} / API {{.Server.APIVersion}} (min {{.Server.MinAPIVersion}})'
EOF
remote 'sudo docker info --format "{{.ServerVersion}}"' >/dev/null 2>&1 \
  && ok "dockerd tourne dans la machine" \
  || { ko "dockerd ne démarre pas"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
log "5. Swarm init"
# ─────────────────────────────────────────────────────────────────────────────
remote 'bash -s' <<'EOF' >/dev/null 2>&1 || true
set -euo pipefail
STATE="$(sudo docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown)"
[ "$STATE" = "active" ] || sudo docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')"
EOF
STATE="$(remote 'sudo docker info --format "{{.Swarm.LocalNodeState}}"' 2>/dev/null || echo unknown)"
[ "$STATE" = "active" ] && ok "swarm actif" || ko "swarm inactif (état: $STATE)"

# ─────────────────────────────────────────────────────────────────────────────
log "6. Réseau overlay — LE test qui tranche"
# ─────────────────────────────────────────────────────────────────────────────
remote "sudo docker network create --driver=overlay --attachable $NET" >/dev/null 2>&1 || true
if remote "sudo docker network inspect $NET --format '{{.Driver}}'" 2>/dev/null | grep -qx overlay; then
  ok "réseau overlay créé"
else
  ko "création du réseau overlay impossible"
fi

# ─────────────────────────────────────────────────────────────────────────────
log "7. Traefik + service routé sur l'overlay"
# ─────────────────────────────────────────────────────────────────────────────
remote 'bash -s' <<EOF >/dev/null 2>&1 || true
set -euo pipefail
if ! sudo docker service inspect probe-traefik >/dev/null 2>&1; then
  timeout 240 sudo docker service create \
    --name probe-traefik \
    --constraint 'node.role==manager' \
    --publish published=80,target=80,mode=host \
    --network $NET \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,ro \
    --detach=false \
    traefik:v3.7.9 \
      --providers.swarm=true \
      --providers.swarm.exposedByDefault=false \
      --providers.swarm.network=$NET \
      --entrypoints.web.address=:80 \
      --log.level=INFO
fi

if ! sudo docker service inspect $APP >/dev/null 2>&1; then
  RULE="Host(\\\`probe.local\\\`)"
  timeout 240 sudo docker service create \
    --name $APP \
    --network $NET \
    --replicas 1 \
    --no-resolve-image \
    --label "traefik.enable=true" \
    --label "traefik.http.routers.$APP.rule=\$RULE" \
    --label "traefik.http.routers.$APP.entrypoints=web" \
    --label "traefik.http.services.$APP.loadbalancer.server.port=$APP_PORT" \
    --detach=false \
    traefik/whoami:latest
fi
EOF

sleep 8

# ─────────────────────────────────────────────────────────────────────────────
log "8. Requête HTTP de bout en bout, à travers Traefik"
# ─────────────────────────────────────────────────────────────────────────────
BODY="$(remote "curl -fsS --max-time 10 -H 'Host: probe.local' http://127.0.0.1/" 2>/dev/null || true)"
if [[ -n "$BODY" ]]; then
  ok "Traefik route jusqu'au service via l'overlay"
  info "$(printf '%s' "$BODY" | head -3 | tr '\n' ' ')"
else
  ko "pas de réponse à travers Traefik"
  info "diagnostic :"
  remote 'sudo docker service ps probe-whoami --no-trunc --filter desired-state=running' 2>/dev/null || true
  remote 'sudo docker service logs probe-traefik --tail 15' 2>&1 | tail -8 || true
fi

# ─────────────────────────────────────────────────────────────────────────────
log "9. Interfaces VXLAN réellement créées ?"
# ─────────────────────────────────────────────────────────────────────────────
VX="$(remote 'sudo ip -d link show 2>/dev/null | grep -c vxlan' 2>/dev/null || echo 0)"
if [[ "${VX:-0}" -gt 0 ]]; then
  ok "$VX interface(s) VXLAN présentes — l'overlay est bien monté"
else
  info "aucune interface VXLAN visible depuis la machine"
  info "(sur un seul nœud ce n'est pas forcément anormal : Swarm peut router"
  info " localement sans monter le VXLAN tant qu'il n'y a pas de second nœud)"
fi

# ─────────────────────────────────────────────────────────────────────────────
printf '\n\033[1m── Verdict ──\033[0m\n'
printf '  réussis : %s\n  échoués : %s\n\n' "$pass" "$fail"
if [[ $fail -eq 0 ]]; then
  cat <<'VERDICT'
  PASS — OrbStack peut servir de boucle de dev rapide.

  Multipass RESTE la référence : c'est la seule cible avec son propre noyau,
  donc la seule qui ressemble au VPS du client. Une boucle rapide ne remplace
  pas la boucle vraie — c'est comme ça qu'on finit par relever la RAM « juste
  pour faire passer un build ».

  Nettoyage : ./probe-orbstack.sh clean
VERDICT
else
  cat <<'VERDICT'
  FAIL — on garde Multipass partout.

  Noter le point de rupture exact dans CLAUDE.md : un avertissement précis
  vaut mieux qu'un « ne pas utiliser DinD » générique.

  Nettoyage : ./probe-orbstack.sh clean
VERDICT
fi
[[ $fail -eq 0 ]]
