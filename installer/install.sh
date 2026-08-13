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
#   5. l'AC et les identifiants du registre d'images
#   6. la pile du plan de contrôle
#   7. les migrations, puis l'adoption de cette machine comme serveur n°1
#
# Idempotent : le relancer sur une installation existante ne casse rien et ne
# régénère aucun secret.

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

# Ajoute une clé au .env si elle n'y est pas encore, sans jamais réécrire celles
# qui s'y trouvent. Le bloc ci-dessous n'est écrit qu'à la PREMIÈRE installation
# — donc une clé introduite par une version ultérieure de Noddle n'y serait
# jamais ajoutée sans ça, et la mise à jour d'une installation existante
# démarrerait avec une variable vide.
ensure_env() {
  if $SUDO grep -qE "^$1=" "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  printf '%s=%s\n' "$1" "$2" | $SUDO tee -a "$ENV_FILE" >/dev/null
}
read_env() { $SUDO grep -E "^$1=" "$ENV_FILE" | cut -d= -f2-; }

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

# Les clés HTTPS, sur un .env écrit AVANT que le chantier TLS existe.
#
# Le bloc ci-dessus n'a lieu qu'à la première installation : une machine
# installée avant la Phase 2 a un .env de trois lignes, sans ces clés-là. C'est
# le fichier qui fait foi pour `CONFIGURED_DOMAIN` plus bas — donc régler
# NODDLE_DOMAIN dans l'environnement resterait sans effet, en silence, et
# l'installation continuerait de servir en clair sans dire pourquoi.
#
# Mesuré sur une VM installée en Phase 1, où ces trois clés manquaient
# effectivement.
ensure_env NODDLE_DOMAIN "${NODDLE_DOMAIN:-}"
ensure_env ACME_EMAIL "${ACME_EMAIL:-}"
ensure_env ACME_CASERVER "${ACME_CASERVER:-}"

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

# L'adresse par laquelle le worker joindra cette machine. Une IP réelle, pas
# `localhost` : le conteneur ne partage pas la pile réseau de l'hôte.
#
# Calculée AVANT l'autorisation de la clé, qui s'en sert pour restreindre les
# sources acceptées. Plus bas, elle y serait vide.
HOST_IP="${HOST_IP:-$(hostname -I | awk '{print $1}')}"

HOST_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -n "$HOST_HOME" ] || die "impossible de trouver le dossier de $TARGET_USER"
$SUDO mkdir -p "$HOST_HOME/.ssh"
$SUDO chmod 700 "$HOST_HOME/.ssh"
PUBKEY="$($SUDO cat "$SSH_KEY.pub")"

# Cette clé vaut root sur la machine : elle ouvre un compte du groupe `docker`,
# et le socket Docker EST un accès root. Sans restriction de source, une copie
# qui fuite — sauvegarde de la base, image disque — est rejouable depuis
# n'importe où sur Internet. `from=` refuse tout ce qui n'est pas local.
#
# Les plages privées ne sont pas décoratives : le worker appelle depuis un
# CONTENEUR, donc sshd voit son adresse sur le réseau Docker, ni 127.0.0.1 ni
# $HOST_IP. Les retirer verrouillerait la porte sur le seul client légitime.
#
# `restrict` est volontairement absent : il coupe le forwarding, dont dockerode
# a besoin pour atteindre le socket Docker à travers le tunnel. Tout déploiement
# s'arrêterait.
SSH_FROM="127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,$HOST_IP"
AUTH_FILE="$HOST_HOME/.ssh/authorized_keys"
AUTH_LINE="from=\"$SSH_FROM\" $PUBKEY"

$SUDO touch "$AUTH_FILE"
if $SUDO grep -qxF "$AUTH_LINE" "$AUTH_FILE"; then
  echo "déjà autorisée pour $TARGET_USER"
else
  # Une entrée antérieure — sans restriction, ou avec une liste de sources
  # périmée après un changement d'IP — est REMPLACÉE, pas doublée. `sed` et non
  # `grep -v` dans un pipe : grep sort en 1 quand il ne reste aucune ligne, et
  # `set -o pipefail` transformerait ce cas normal en échec d'installation.
  $SUDO sed -i "\|$PUBKEY|d" "$AUTH_FILE"
  echo "$AUTH_LINE" | $SUDO tee -a "$AUTH_FILE" >/dev/null
  $SUDO chmod 600 "$AUTH_FILE"
  $SUDO chown -R "$TARGET_USER" "$HOST_HOME/.ssh"
  echo "autorisée pour $TARGET_USER (sources : $SSH_FROM)"
fi

# Le worker construit sur la cible et a besoin de nixpacks LÀ-BAS. Cette
# machine étant une cible, elle doit l'avoir.
if ! command -v nixpacks >/dev/null 2>&1; then
  say "nixpacks"
  curl -sSL https://nixpacks.com/install.sh | $SUDO bash
fi

# ── 5. Registre d'images ─────────────────────────────────────────────────────
#
# Sans registre, une image construite n'existe QUE sur le nœud qui l'a
# construite. Swarm ne peut alors ni la replanifier ailleurs, ni la retrouver
# si la machine meurt — d'où la contrainte de placement que chaque service
# portait jusqu'ici. Le registre est EMBARQUÉ, comme Postgres et Redis : un
# registre externe demanderait un compte tiers et des identifiants collés
# AVANT le premier déploiement, ce qui casse « une commande sur n'importe quel
# VPS ».
#
# Il porte son propre TLS, signé par une AC générée ici — ni Traefik, ni ACME.
# Deux raisons : un certificat public est impossible sur une installation
# qu'on atteint par son IP, et faire dépendre le registre d'un domaine
# donnerait deux chemins de code dont un seul serait jamais exercé.
#
# L'AC est ensuite déposée sur chaque nœud dans /etc/docker/certs.d/, que le
# démon relit à CHAQUE requête. Mesuré sur un démon en place depuis trois
# jours : le push passe de « x509: certificate signed by unknown authority » à
# réussi sans qu'aucun service Docker ne redémarre. C'est ce qui permet de
# migrer une installation qui tourne sans couper une seule application —
# `insecure-registries` dans daemon.json, lui, aurait exigé un redémarrage du
# démon, donc une coupure de toutes les tasks du nœud.
say "Registre d'images"
$SUDO mkdir -p "$REGISTRY_DIR"
$SUDO chmod 700 "$REGISTRY_DIR"

# L'adresse est figée ICI, une fois pour toutes, et relue du .env aux
# exécutions suivantes : c'est elle qui est inscrite dans chaque `image_tag`
# de l'historique des déploiements. La recalculer à chaque fois ferait mentir
# tous les déploiements passés le jour où `hostname -I` répond autre chose.
#
# Le port 5000 est publié comme 2377 l'est déjà pour Swarm : les nœuds
# joignent le manager par CETTE adresse, c'est ainsi qu'ils ont rejoint le
# cluster. Contrairement à 2377, celui-ci demande un mot de passe.
ensure_env REGISTRY_HOST "$HOST_IP:5000"
ensure_env REGISTRY_PASSWORD "$(openssl rand -hex 24)"
REGISTRY_HOST="$(read_env REGISTRY_HOST)"
REGISTRY_ADDR="${REGISTRY_HOST%:*}"

if $SUDO test -f "$REGISTRY_DIR/ca.crt" && $SUDO test -f "$REGISTRY_DIR/htpasswd"; then
  echo "AC et identifiants déjà en place"
else
  # On ne passe ici que si l'AC n'existe pas : la régénérer invaliderait la
  # confiance déjà déposée sur tous les nœuds provisionnés, qui portent la
  # PRÉCÉDENTE. Ils cesseraient de pouvoir tirer, sans rien pour l'expliquer.

  # Un `subjectAltName` a un type. Sur `HOST_IP` réglé à la main sur un nom,
  # `IP:` produirait un certificat qu'aucun client n'accepte. Pas de
  # `… | grep` ici pour trancher : sous `pipefail` c'est la course au SIGPIPE
  # déjà payée en Phase 0.
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

  # Le registre n'accepte QUE du bcrypt, et rien de ce qui est présent sur une
  # machine nue n'en produit : `htpasswd` n'est pas installé sur une Ubuntu
  # 24.04 nue, `openssl passwd -5` rend du SHA-256 crypt, et registry:3
  # n'embarque pas htpasswd non plus. Les trois ont été essayés. Docker, lui,
  # est garanti présent à ce stade du script.
  #
  # `-i` (mot de passe sur l'entrée standard) et jamais `-b` : les arguments
  # d'un `docker run` sont lisibles dans `ps` le temps de l'exécution. Le tube
  # vient de `printf`, pas de l'entrée du script — `curl | bash` n'est donc pas
  # en cause ici.
  printf '%s' "$(read_env REGISTRY_PASSWORD)" \
    | $SUDO docker run --rm -i httpd:2-alpine htpasswd -Bin noddle 2>/dev/null \
    | $SUDO tee "$REGISTRY_DIR/htpasswd" >/dev/null
  $SUDO docker rmi httpd:2-alpine >/dev/null 2>&1 || true

  $SUDO chmod 600 "$REGISTRY_DIR"/*
  $SUDO chmod 644 "$REGISTRY_DIR/ca.crt"
  echo "AC générée pour $REGISTRY_HOST (valable 10 ans)"
fi

# ── 6. La pile ───────────────────────────────────────────────────────────────
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

# Le commit qu'on est en train de construire, inscrit DANS les deux images.
#
# C'est ce que le bouton de mise à jour sonde pour savoir si le nouveau code
# tourne. Il ne peut pas lire le HEAD du disque à la place : ce checkout a eu
# lieu à l'étape « Sources », donc des minutes avant que la pile redémarre, et
# l'écran annoncerait une mise à jour terminée pendant que l'ancienne version
# sert encore.
#
# Exporté plutôt que passé en `--build-arg` : les deux services le déclarent
# dans leur `args`, et compose lit l'environnement pour les substituer.
NODDLE_COMMIT="$($SUDO git -C "$NODDLE_DIR" rev-parse HEAD 2>/dev/null || echo '')"
export NODDLE_COMMIT
[ -n "$NODDLE_COMMIT" ] && echo "version : ${NODDLE_COMMIT:0:12}"

"${COMPOSE[@]}" build </dev/null

# La BASE d'abord, seule, et on attend qu'elle soit saine. Le reste de la pile
# ne démarre qu'APRÈS les migrations, plus bas.
#
# L'ordre inverse — tout démarrer puis migrer — laissait le worker neuf tourner
# contre l'ANCIEN schéma pendant toute la durée des migrations. Mesuré à la
# seconde sur la mise à jour du VPS vers 19b760d : worker démarré à 11:26:53,
# `sweepWatch` échoué à 11:26:56 sur `stacks.swarm_name`, la colonne que la
# migration allait justement poser. Ça n'a coûté qu'un passage de surveillance,
# rejoué ensuite — mais la fenêtre vaut ce que durent les migrations, et le
# worker traite la file pendant ce temps.
#
# `--wait` et pas seulement `up -d` : `compose run` porte `--no-deps`, donc il
# ne démarrerait pas Postgres lui-même et échouerait sur une base pas encore
# prête. Le healthcheck (`pg_isready`) est ce qui rend l'attente fiable.
"${COMPOSE[@]}" up -d --wait postgres </dev/null

# ── 7. Base et adoption ──────────────────────────────────────────────────────
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

# Le schéma est à jour : le reste de la pile peut démarrer. C'est seulement ici
# que le web et le worker voient la base, et ils la voient déjà migrée.
say "Démarrage du plan de contrôle"
"${COMPOSE[@]}" up -d </dev/null

say "Adoption de cette machine comme serveur n°1"
"${COMPOSE[@]}" run --rm --no-deps -T \
  -e HOST_IP="$HOST_IP" \
  -e HOST_USER="$TARGET_USER" \
  -e HOST_SSH_KEY="$SSH_DIR/id_ed25519" \
  -e HOST_NAME="$(hostname)" \
  worker node src/target/adopt-host.ts </dev/null

printf '\n\033[32m✓ Noddle est installé.\033[0m\n\n'
if [ -n "$CONFIGURED_DOMAIN" ]; then
  printf '  Dashboard : https://%s\n' "$CONFIGURED_DOMAIN"
  printf '              (le premier chargement attend le certificat, quelques secondes)\n'
else
  printf '  Dashboard : http://%s\n' "$HOST_IP"
fi
printf '  Secrets   : %s  (sauvegardez ce fichier)\n' "$ENV_FILE"
printf '\n  Le premier écran crée le compte administrateur.\n\n'
