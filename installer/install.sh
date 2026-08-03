#!/usr/bin/env bash
#
# Installe Noddle sur cette machine, en une commande.
#
#   curl -fsSL https://raw.githubusercontent.com/lucien-loua/noddle/main/installer/install.sh | bash
#
# Ce que fait ce script, dans l'ordre :
#   1. Docker (installé si absent) et Swarm activé
#   2. le réseau overlay que partagent le proxy et les applications
#   3. les secrets — APP_KEY et mot de passe Postgres, générés ici
#   4. une paire de clés SSH, autorisée sur CETTE machine
#   5. la pile du plan de contrôle
#   6. les migrations, puis l'adoption de cette machine comme serveur n°1
#
# Idempotent : le relancer sur une installation existante ne casse rien et ne
# régénère aucun secret.

set -euo pipefail

NODDLE_DIR="${NODDLE_DIR:-/opt/noddle}"
NODDLE_REPO="${NODDLE_REPO:-https://github.com/lucien-loua/noddle.git}"
NODDLE_REF="${NODDLE_REF:-main}"
SSH_DIR="/etc/noddle/ssh"
SSH_KEY="$SSH_DIR/id_ed25519"
NETWORK="noddle-public"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "Noddle s'installe sur Linux."

# On veut pouvoir élever, sans exiger d'être root : `curl | bash` en root est
# une habitude qu'il vaut mieux ne pas encourager.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  TARGET_USER="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null 2>&1 || die "sudo est requis (ou lancez en root)."
  SUDO="sudo"
  TARGET_USER="$USER"
fi

# ── 1. Docker ────────────────────────────────────────────────────────────────
say "Docker"
if command -v docker >/dev/null 2>&1; then
  echo "déjà présent : $(docker --version)"
else
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO usermod -aG docker "$TARGET_USER" || true
fi

docker compose version >/dev/null 2>&1 \
  || die "le plugin docker compose est absent — installez docker-compose-plugin."

# JAMAIS `docker info | grep -q 'Swarm: active'`. grep -q sort au premier
# résultat, docker info prend un SIGPIPE, et `set -o pipefail` transforme ça en
# échec de pipeline. C'est une COURSE : le même code passe ou casse d'une
# exécution à l'autre, et relance `swarm init` sur un nœud déjà en swarm.
SWARM_STATE="$($SUDO docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown)"
if [ "$SWARM_STATE" != "active" ]; then
  say "Activation de Swarm"
  $SUDO docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')"
else
  echo "Swarm déjà actif"
fi

# Attachable : le plan de contrôle tourne en Compose et doit rejoindre le même
# réseau que les services Swarm déployés, sinon Traefik ne peut pas les
# joindre.
$SUDO docker network create --driver=overlay --attachable "$NETWORK" 2>/dev/null \
  && echo "réseau $NETWORK créé" \
  || echo "réseau $NETWORK déjà là"

# ── 2. Sources ───────────────────────────────────────────────────────────────
say "Sources"
if [ -d "$NODDLE_DIR/.git" ]; then
  $SUDO git -C "$NODDLE_DIR" fetch --depth 1 origin "$NODDLE_REF"
  $SUDO git -C "$NODDLE_DIR" checkout -q FETCH_HEAD
  echo "mises à jour dans $NODDLE_DIR"
else
  command -v git >/dev/null 2>&1 || $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git
  $SUDO git clone --depth 1 --branch "$NODDLE_REF" "$NODDLE_REPO" "$NODDLE_DIR"
  echo "clonées dans $NODDLE_DIR"
fi

# ── 3. Secrets ───────────────────────────────────────────────────────────────
say "Secrets"
ENV_FILE="$NODDLE_DIR/installer/.env"
if $SUDO test -f "$ENV_FILE"; then
  echo "conservés : $ENV_FILE existe déjà"
else
  # APP_KEY chiffre les clés SSH et les variables d'environnement au repos.
  # La perdre rend TOUS les secrets stockés illisibles — c'est le fichier à
  # sauvegarder.
  $SUDO tee "$ENV_FILE" >/dev/null <<EOF
APP_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NODDLE_URL=${NODDLE_URL:-}
# HTTPS. Les deux ensemble, ou aucun : Let's Encrypt certifie un NOM, jamais
# une adresse IP. Sans domaine, Noddle sert en HTTP simple — ce qui reste
# correct pour une machine qu'on atteint par son IP.
NODDLE_DOMAIN=${NODDLE_DOMAIN:-}
ACME_EMAIL=${ACME_EMAIL:-}
# Vide = le vrai Let's Encrypt. Le serveur de test sert à la mise au point,
# sans consommer le quota de production.
ACME_CASERVER=${ACME_CASERVER:-}
EOF
  $SUDO chmod 600 "$ENV_FILE"
  echo "générés dans $ENV_FILE (à sauvegarder)"
fi

# ── 4. Clé SSH de la machine ─────────────────────────────────────────────────
#
# L'installateur enregistre sa propre machine comme serveur cible n°1, et elle
# passe par l'exécuteur SSH comme n'importe quelle autre : pas de branche
# `localhost`. Le chemin de bouclage est donc exercé par tous les utilisateurs
# mono-machine, et ne peut pas pourrir sans que ça se voie.
say "Accès SSH à cette machine"
$SUDO mkdir -p "$SSH_DIR"
$SUDO chmod 700 "$SSH_DIR"
if $SUDO test -f "$SSH_KEY"; then
  echo "clé déjà présente"
else
  $SUDO ssh-keygen -t ed25519 -N "" -C "noddle@$(hostname)" -f "$SSH_KEY" -q
  echo "paire générée"
fi

HOST_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -n "$HOST_HOME" ] || die "impossible de trouver le dossier de $TARGET_USER"
$SUDO mkdir -p "$HOST_HOME/.ssh"
$SUDO chmod 700 "$HOST_HOME/.ssh"
PUBKEY="$($SUDO cat "$SSH_KEY.pub")"
if $SUDO grep -qF "$PUBKEY" "$HOST_HOME/.ssh/authorized_keys" 2>/dev/null; then
  echo "déjà autorisée pour $TARGET_USER"
else
  echo "$PUBKEY" | $SUDO tee -a "$HOST_HOME/.ssh/authorized_keys" >/dev/null
  $SUDO chmod 600 "$HOST_HOME/.ssh/authorized_keys"
  $SUDO chown -R "$TARGET_USER" "$HOST_HOME/.ssh"
  echo "autorisée pour $TARGET_USER"
fi

# L'adresse par laquelle le worker joindra cette machine. Une IP réelle, pas
# `localhost` : le conteneur ne partage pas la pile réseau de l'hôte.
HOST_IP="${HOST_IP:-$(hostname -I | awk '{print $1}')}"

# Le worker construit sur la cible et a besoin de nixpacks LÀ-BAS. Cette
# machine étant une cible, elle doit l'avoir.
if ! command -v nixpacks >/dev/null 2>&1; then
  say "nixpacks"
  curl -sSL https://nixpacks.com/install.sh | $SUDO bash
fi

# ── 5. La pile ───────────────────────────────────────────────────────────────
say "Construction et démarrage du plan de contrôle"

# Le domaine est lu depuis le .env, pas depuis l'environnement : sur une
# réinstallation, c'est le fichier qui fait foi — il a été conservé plus haut.
CONFIGURED_DOMAIN="$($SUDO grep -E '^NODDLE_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
CONFIGURED_EMAIL="$($SUDO grep -E '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)"

COMPOSE_FILES=(-f "$NODDLE_DIR/installer/docker-compose.yml")
if [ -n "$CONFIGURED_DOMAIN" ]; then
  [ -n "$CONFIGURED_EMAIL" ] \
    || die "NODDLE_DOMAIN est défini mais ACME_EMAIL est vide — Let's Encrypt exige une adresse de contact."
  COMPOSE_FILES+=(-f "$NODDLE_DIR/installer/docker-compose.tls.yml")
  echo "HTTPS activé pour $CONFIGURED_DOMAIN"
else
  echo "HTTP simple : aucun domaine configuré (NODDLE_DOMAIN vide)"
fi

# `$SUDO` est VIDE quand on est déjà root, et un tableau ne l'oublie pas comme
# le fait le découpage en mots : `"${COMPOSE[@]}"` passerait une chaîne vide en
# guise de commande, et bash répond « : command not found ». Le préfixe n'est
# donc ajouté que s'il existe. Mesuré en installant en root — tous les essais
# précédents tournaient sous un utilisateur avec sudo, où le bug est invisible.
COMPOSE=(docker compose --project-directory "$NODDLE_DIR/installer" --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")
[ -z "$SUDO" ] || COMPOSE=("$SUDO" "${COMPOSE[@]}")
"${COMPOSE[@]}" build </dev/null
"${COMPOSE[@]}" up -d </dev/null

# ── 6. Base et adoption ──────────────────────────────────────────────────────
#
# `</dev/null` sur chaque `docker compose run` n'est pas cosmétique : la
# méthode d'installation documentée est `curl | bash`, qui alimente CE script
# par son entrée standard. Sans cette redirection, `docker compose run`
# hérite du même flux et y lit — même sans TTY, `-T` ne ferme pas l'entrée. Le
# sous-processus consomme alors la SUITE du script encore non lue par bash,
# qui atteint une fin de fichier silencieuse et sort en code 0 sans exécuter
# les commandes restantes. Aucune erreur nulle part : juste un script qui
# s'arrête. Mesuré ici — les migrations tournaient, l'adoption jamais, et
# `$?` valait 0 dans les deux sens de vérification.
say "Migrations"
"${COMPOSE[@]}" run --rm --no-deps -T worker \
  node /noddle/packages/db/src/migrate.ts </dev/null

say "Adoption de cette machine comme serveur n°1"
"${COMPOSE[@]}" run --rm --no-deps -T \
  -e HOST_IP="$HOST_IP" \
  -e HOST_USER="$TARGET_USER" \
  -e HOST_SSH_KEY="$SSH_DIR/id_ed25519" \
  -e HOST_NAME="$(hostname)" \
  worker node src/adopt-host.ts </dev/null

printf '\n\033[32m✓ Noddle est installé.\033[0m\n\n'
if [ -n "$CONFIGURED_DOMAIN" ]; then
  printf '  Dashboard : https://%s\n' "$CONFIGURED_DOMAIN"
  printf '              (le premier chargement attend le certificat, quelques secondes)\n'
else
  printf '  Dashboard : http://%s\n' "$HOST_IP"
fi
printf '  Secrets   : %s  (sauvegardez ce fichier)\n' "$ENV_FILE"
printf '\n  Le premier écran crée le compte administrateur.\n\n'
