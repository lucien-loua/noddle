// Le registre d'images : ce qui rend une image portable entre les nœuds.
//
// Sans lui, `docker buildx build --load` laisse l'image dans le magasin du
// SEUL nœud qui l'a construite. Swarm ne peut alors ni la planifier ailleurs,
// ni la retrouver si la machine meurt — d'où la contrainte `node.id==…` que
// chaque service portait jusqu'ici.
//
// Trois choses vivent ici, et rien d'autre :
//   - déposer l'AC sur un nœud, pour que son démon accepte le registre ;
//   - pousser une image, sans que le mot de passe touche un argv ;
//   - dire si une référence d'image est portable ou locale à un nœud.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { Database } from "@noddle/db";
import { servers } from "@noddle/db/schema";
import {
  disconnect,
  dockerClient,
  type ExecOptions,
  execArgv,
  type SshClient,
  writeRemoteFile,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { getSwarmNodeId } from "#swarm";

type ServerRow = typeof servers.$inferSelect;

/**
 * Le compte du registre. Constante et non réglage : l'installateur écrit ce
 * même nom dans le htpasswd, et un second compte n'aurait personne à
 * distinguer — il n'y a qu'un producteur d'images, le worker.
 */
export const REGISTRY_USER = "noddle";

/** Chemin de l'AC dans le conteneur worker, monté par la pile du plan de contrôle. */
const CA_PATH = "/etc/noddle/registry/ca.crt";

export interface RegistryConfig {
  /** PEM de l'AC qui signe le certificat du registre. */
  caCert: string;
  /** `hôte:port`, exactement tel qu'il apparaît dans les tags d'images. */
  host: string;
  password: string;
}

/**
 * Lit la configuration du registre depuis l'environnement, ou rend `undefined`.
 *
 * `undefined` n'est pas une erreur : c'est le comportement d'AVANT le registre
 * — build local, service épinglé à son nœud — et c'est ce qui rend la mise à
 * jour d'une installation existante sans danger. Du code neuf sur une pile pas
 * encore redémarrée se comporte exactement comme l'ancien.
 */
export function loadRegistryConfig(): RegistryConfig | undefined {
  const host = process.env.REGISTRY_HOST;
  const password = process.env.REGISTRY_PASSWORD;
  if (!(host && password)) {
    return;
  }
  let caCert: string;
  try {
    caCert = readFileSync(CA_PATH, "utf8");
  } catch (err) {
    // Pas de retour silencieux au mode local ici : REGISTRY_HOST est présent,
    // donc l'installation SE CROIT dotée d'un registre. Démarrer quand même
    // produirait des déploiements épinglés que personne n'aurait demandés, et
    // le défaut ne se verrait que le jour où un nœud tombe.
    //
    // La cause est reprise telle quelle : « fichier absent » et « permission
    // refusée » appellent deux gestes différents, et le second se produit si
    // le montage a été fait sur le répertoire au lieu du seul certificat.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `REGISTRY_HOST est défini mais l'AC est illisible (${CA_PATH}) — l'installateur a-t-il tourné ? ${detail}`,
      { cause: err }
    );
  }
  return { caCert, host, password };
}

// ─────────────────────────────────────────────────────────────────────────────
// Confiance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dépose l'AC du registre sur un nœud.
 *
 * `/etc/docker/certs.d/<hôte:port>/ca.crt` est relu par le démon à CHAQUE
 * requête vers ce registre — mesuré sur un démon en place depuis trois jours :
 * le push passe de « x509: certificate signed by unknown authority » à réussi
 * sans qu'aucun service Docker ne redémarre.
 *
 * C'est ce qui distingue cette voie d'`insecure-registries` dans daemon.json,
 * qui aurait exigé un redémarrage du démon — donc, en mode Swarm où
 * `live-restore` n'existe pas, une coupure de toutes les tasks du nœud. Migrer
 * une installation qui tourne ne coupe ainsi rien.
 *
 * Rend `true` si le fichier a été écrit, `false` s'il était déjà bon. Rejouable
 * sans effet : c'est un provisionnement, il tourne à chaque ajout de serveur et
 * au démarrage du worker.
 */
export async function ensureRegistryTrust(
  client: SshClient,
  registry: RegistryConfig
): Promise<boolean> {
  const dir = `/etc/docker/certs.d/${registry.host}`;
  const target = `${dir}/ca.crt`;

  const current = await execArgv(client, ["sudo", "cat", target]);
  if (current.code === 0 && current.stdout.trim() === registry.caCert.trim()) {
    return false;
  }

  // Par SFTP puis `sudo install`, et non par un heredoc : un PEM est inerte,
  // mais le faire traverser un shell distant rouvrirait la classe d'injection
  // que `writeRemoteFile` existe pour fermer. L'utilisateur SSH ne peut pas
  // écrire sous /etc, d'où le passage par /tmp.
  const staging = `/tmp/noddle-ca-${randomBytes(6).toString("hex")}.crt`;
  await writeRemoteFile(client, staging, registry.caCert);
  try {
    // `install -D` crée les répertoires parents ET pose le mode en une fois.
    // Le nom du répertoire contient un « : » — d'où execArgv, jamais une
    // chaîne concaténée.
    const res = await execArgv(client, [
      "sudo",
      "install",
      "-D",
      "-m",
      "644",
      staging,
      target,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `dépôt de l'AC du registre impossible : ${res.stderr.trim() || res.stdout.trim()}`
      );
    }
  } finally {
    await execArgv(client, ["rm", "-f", staging]);
  }
  return true;
}

/**
 * Passe sur chaque serveur `connected` et s'assure qu'il fait confiance au
 * registre — et qu'on connaît son identifiant de nœud Swarm.
 *
 * UN PASSAGE, et pas une action unique au démarrage. Deux raisons :
 *
 *   - la MIGRATION. Les serveurs déjà provisionnés l'ont été avant que le
 *     registre existe ; personne ne repassera par `provisionServer` pour eux.
 *     Sans ce passage, ils resteraient incapables de tirer une image, et le
 *     défaut ne se verrait qu'à la première task que Swarm y planifie.
 *   - un serveur injoignable au démarrage du worker ne doit pas rester exclu
 *     pour toujours. Il redevient joignable, le passage suivant le rattrape.
 *
 * Même forme que `sweepWatch`/`sweepBackups`/`collectMetrics`, et pour la même
 * raison : l'état vit dans Postgres, un Redis vidé ne fait rien disparaître.
 *
 * Un serveur injoignable est SAUTÉ, jamais marqué en échec : ce passage n'est
 * pas une sonde de disponibilité, et écraser `lastError` avec sa propre erreur
 * masquerait la vraie cause déjà relevée par le provisionnement.
 */
export async function sweepRegistryTrust(opts: {
  /**
   * Injecté plutôt qu'importé de `#deploy` : ce module-là importe celui-ci
   * pour pousser, et le cycle serait réel — les imports de TYPE s'effacent à
   * la compilation, pas ceux de fonctions.
   */
  connectTo: (server: ServerRow) => Promise<SshClient>;
  db: Database;
  registry?: RegistryConfig;
}): Promise<{ skipped: number; trusted: number }> {
  const result = { skipped: 0, trusted: 0 };
  const { registry } = opts;
  if (!registry) {
    return result;
  }

  const connected = await opts.db.query.servers.findMany({
    where: eq(servers.status, "connected"),
  });

  for (const server of connected) {
    let client: SshClient | undefined;
    try {
      // Une session SSH par machine, ouverte et refermée l'une après l'autre.
      // Les paralléliser ouvrirait N connexions simultanées depuis une machine
      // à 2 Go, pour un travail qui ne fait qu'écrire un fichier de 2 Ko.
      // biome-ignore lint/performance/noAwaitInLoops: séquentiel volontaire
      client = await opts.connectTo(server);
      const written = await ensureRegistryTrust(client, registry);
      if (written) {
        result.trusted += 1;
      }
      if (!server.swarmNodeId) {
        // Rattrape les serveurs provisionnés avant que la colonne existe.
        const nodeId = await getSwarmNodeId(dockerClient(client));
        await opts.db
          .update(servers)
          .set({ swarmNodeId: nodeId })
          .where(eq(servers.id, server.id));
      }
    } catch {
      result.skipped += 1;
    } finally {
      if (client) {
        disconnect(client);
      }
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Push
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le fichier d'identifiants que `docker --config` lit, fabriqué ici plutôt
 * qu'obtenu par `docker login`.
 *
 * `docker login --password-stdin` supposerait un tube, donc une chaîne shell
 * `printf '%s' '<secret>' | …` — et cette chaîne devient l'argv du shell que
 * SSH lance, lisible dans `ps` sur la machine cible le temps de l'exécution.
 * Écrire le fichier directement supprime l'étape : aucun processus ne voit
 * jamais le mot de passe.
 */
function dockerConfigJson(registry: RegistryConfig): string {
  const auth = Buffer.from(`${REGISTRY_USER}:${registry.password}`).toString(
    "base64"
  );
  return JSON.stringify({ auths: { [registry.host]: { auth } } });
}

export interface PushOptions extends ExecOptions {
  /** Tag complet, déjà qualifié par l'hôte du registre. */
  imageTag: string;
  /**
   * Retire la copie locale après un push réussi. C'est le nœud de build qui
   * cesse ainsi d'accumuler : l'image vit désormais dans le registre, et Swarm
   * la retirera de là — y compris sur ce nœud-ci.
   */
  removeLocal?: boolean;
}

/**
 * Pousse une image déjà construite, par le démon de l'hôte.
 *
 * Et NON par `buildx --push`, qui serait pourtant plus direct : le push de
 * buildx est effectué par `buildkitd`, qui tourne dans le conteneur du builder
 * capé et possède son propre magasin d'AC racine. Notre AC n'y est pas, et l'y
 * mettre est un problème distinct, non mesuré. Le démon de l'hôte, lui, a déjà
 * `/etc/docker/certs.d`.
 */
export async function pushImage(
  client: SshClient,
  registry: RegistryConfig,
  o: PushOptions
): Promise<void> {
  if (!o.imageTag.startsWith(`${registry.host}/`)) {
    throw new Error(
      `image à pousser non qualifiée par le registre : ${o.imageTag}`
    );
  }

  const dir = `/tmp/noddle-push-${randomBytes(6).toString("hex")}`;
  // Le mode 700 est posé sur le RÉPERTOIRE avant l'écriture : SFTP crée le
  // fichier avec l'umask de la session, et c'est le répertoire qui le protège.
  const made = await execArgv(client, ["mkdir", "-p", "-m", "700", dir]);
  if (made.code !== 0) {
    throw new Error(`répertoire d'identifiants impossible : ${made.stderr}`);
  }

  try {
    await writeRemoteFile(
      client,
      `${dir}/config.json`,
      dockerConfigJson(registry)
    );
    const res = await execArgv(
      client,
      ["sudo", "docker", "--config", dir, "push", o.imageTag],
      { onStderr: o.onStderr, onStdout: o.onStdout }
    );
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout)
        .trim()
        .split("\n")
        .slice(-6)
        .join("\n");
      throw new Error(
        `push vers le registre échoué (code ${res.code})\n${tail}`
      );
    }
  } finally {
    // Toujours, même si le push a levé : les identifiants ne restent pas sur
    // la machine cible.
    await execArgv(client, ["rm", "-rf", dir]);
  }

  if (o.removeLocal) {
    // Sans importance si ça échoue : l'image est dans le registre, c'est le
    // seul fait qui compte pour la suite. Un `rmi` refusé — parce qu'un
    // conteneur l'utilise encore — ne doit pas transformer un déploiement
    // réussi en déploiement échoué.
    await execArgv(client, ["sudo", "docker", "rmi", o.imageTag]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Portabilité d'une référence d'image
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le tag d'une image poussée : `<hôte:port>/<service>:<sha>-<horodatage>`.
 *
 * Le préfixe n'est pas décoratif — c'est lui que Docker lit pour savoir où
 * tirer, et c'est donc lui qui porte le fait « cette image est portable ».
 */
export function registryImageTag(
  registry: RegistryConfig,
  name: string,
  version: string
): string {
  return `${registry.host}/${name}:${version}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rétention
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Combien de versions par service le registre conserve.
 *
 * Il faut le dire franchement : ceci ROGNE le « revenir à n'importe quelle
 * version antérieure » qui distingue Noddle de Swarm — ça devient « n'importe
 * laquelle des dix dernières ». Mais l'alternative n'est pas « toutes » : sans
 * rétention la limite existe quand même, c'est « jusqu'à ce que le disque soit
 * plein », et celle-là n'est annoncée nulle part et arrive sans prévenir.
 *
 * Dix, parce que la couche de base nixpacks est PARTAGÉE entre toutes les
 * versions d'un service : mesuré, une seconde image ne coûte que sa propre
 * couche applicative. Le coût de dix versions est donc proche de celui d'une.
 */
export const KEEP_PER_SERVICE = 10;

/**
 * Un appel à l'API du registre, avec SON AC et rien qu'elle.
 *
 * `fetch` obligerait à faire confiance à l'AC au niveau du PROCESSUS entier
 * (`NODE_EXTRA_CA_CERTS`), donc aussi pour S3 et pour les notifications, qui
 * n'ont rien à voir avec elle. `node:https` prend la chaîne de confiance par
 * requête : la portée correspond alors à ce qu'on voulait dire.
 *
 * Accessoirement, ça rend les pannes lisibles. `fetch` échoue en « fetch
 * failed » quoi qu'il arrive — le même message opaque déjà relevé sur les
 * notifications ; ici l'erreur porte le code TLS réel.
 */
function registryRequest(
  registry: RegistryConfig,
  o: { headers?: Record<string, string>; method: string; path: string }
): Promise<{
  headers: Record<string, string | string[] | undefined>;
  status: number;
}> {
  const [hostname, port] = registry.host.split(":");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        ca: registry.caCert,
        headers: {
          authorization: `Basic ${Buffer.from(`${REGISTRY_USER}:${registry.password}`).toString("base64")}`,
          ...o.headers,
        },
        hostname,
        method: o.method,
        path: o.path,
        port: port ?? "443",
      },
      (res) => {
        // Le corps ne nous sert jamais — seuls le statut et les en-têtes
        // portent la réponse — mais il DOIT être consommé, sinon la socket
        // reste ouverte et le processus ne rend pas la main.
        res.resume();
        res.on("end", () =>
          resolve({ headers: res.headers, status: res.statusCode ?? 0 })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** Découpe `hôte:port/dépôt:tag` en ses deux moitiés utiles. */
export function parseRegistryRef(
  image: string,
  registry: RegistryConfig
): { repository: string; tag: string } | null {
  const prefix = `${registry.host}/`;
  if (!image.startsWith(prefix)) {
    return null;
  }
  const rest = image.slice(prefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) {
    return null;
  }
  return { repository: rest.slice(0, colon), tag: rest.slice(colon + 1) };
}

/**
 * Supprime le manifeste d'un tag. Rend `true` s'il n'est plus là après coup.
 *
 * Ceci ne libère AUCUN octet à soi seul — mesuré : le tag disparaît de
 * `tags/list` et le volume ne bouge pas. Les couches restent, référencées par
 * rien. C'est `garbageCollect` qui les rend, et il ne peut collecter que des
 * manifestes déjà supprimés. Les deux vont ensemble ou ne servent à rien : le
 * même piège que « supprimer la ligne sans supprimer l'objet » déjà payé sur
 * les sauvegardes.
 */
export async function deleteManifest(
  registry: RegistryConfig,
  ref: { repository: string; tag: string }
): Promise<boolean> {
  // Le digest ne se lit que si l'on ANNONCE les types de manifeste acceptés :
  // sans cet en-tête, le registre répond dans un format ancien et le
  // `Docker-Content-Digest` ne désigne pas le manifeste qu'on veut effacer.
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");

  const head = await registryRequest(registry, {
    headers: { accept },
    method: "HEAD",
    path: `/v2/${ref.repository}/manifests/${ref.tag}`,
  });
  const digest = head.headers["docker-content-digest"];
  if (
    !(head.status >= 200 && head.status < 300 && typeof digest === "string")
  ) {
    return false;
  }
  const del = await registryRequest(registry, {
    method: "DELETE",
    path: `/v2/${ref.repository}/manifests/${digest}`,
  });
  // 202 = accepté, 404 = déjà parti. Les deux valent « il n'est plus là ».
  return del.status === 202 || del.status === 404;
}

/**
 * Rend les octets des couches que plus aucun manifeste ne référence.
 *
 * Tourne DANS le conteneur du registre, sur le manager : c'est un travail sur
 * le système de fichiers du registre, pas un appel d'API.
 *
 * ⚠ à ne jamais faire tourner pendant un push. Une couche en cours d'envoi
 * n'est référencée par aucun manifeste — donc collectable — et le push
 * réussirait en laissant une image incomplète. C'est pourquoi la rétention
 * passe par la MÊME file que les déploiements, en concurrence 1.
 */
export async function garbageCollect(
  managerClient: SshClient,
  containerName: string
): Promise<void> {
  const res = await execArgv(managerClient, [
    "sudo",
    "docker",
    "exec",
    containerName,
    "registry",
    "garbage-collect",
    "--delete-untagged",
    // registry 3 a déplacé ce chemin depuis /etc/docker/registry de la v2.
    "/etc/distribution/config.yml",
  ]);
  if (res.code !== 0) {
    throw new Error(
      `garbage-collect a échoué (code ${res.code}) : ${res.stderr.trim().split("\n").slice(-3).join(" ")}`
    );
  }
}

/**
 * Une image est-elle joignable depuis N'IMPORTE QUEL nœud ?
 *
 * Ce n'est pas une heuristique : c'est exactement le fait que Docker lui-même
 * lit dans la référence pour décider d'où tirer. Une référence sans hôte de
 * registre désigne le magasin LOCAL du nœud, donc une image qui n'existe nulle
 * part ailleurs.
 *
 * C'est cette fonction qui décide de la contrainte de placement, déploiement
 * par déploiement — jamais un réglage global. Un rollback vers une image
 * d'avant le registre reste ainsi épinglé au nœud qui la détient, et continue
 * de fonctionner, pendant que les déploiements neufs sont libres.
 */
export function isPortableImage(
  image: string,
  registry: RegistryConfig | undefined
): boolean {
  return registry !== undefined && image.startsWith(`${registry.host}/`);
}
