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
import {
  type ExecOptions,
  execArgv,
  type SshClient,
  writeRemoteFile,
} from "@noddle/ssh-executor";

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
