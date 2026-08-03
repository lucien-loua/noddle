// Le dépôt d'objets des sauvegardes : un stockage compatible S3.
//
// Paquet à part plutôt que du code dans le worker, parce que DEUX processus en
// ont besoin, sur deux runtimes : le worker (Node) téléverse et relit les
// dumps, le web (Bun) éprouve les identifiants au moment où on les saisit. Le
// SDK AWS a été mesuré sur les deux contre un vrai RustFS avant d'être retenu
// — 8/8 de chaque côté, sommes de contrôle par défaut comprises.
//
// Pourquoi le SDK et pas du HTTP à la main : SigV4 et le téléversement
// multipart. Signer soi-même est exactement ce qu'on ne fait pas soi-même, et
// un dump n'a pas de taille connue d'avance, donc un simple PUT ne suffit pas.

import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/**
 * 8 Mio par part et deux parts en vol : la mémoire du téléversement est
 * bornée à ~16 Mio quelle que soit la taille du dump. Ce plan de contrôle
 * partage une machine à 2 Go avec les applications qu'il déploie ; laisser le
 * SDK sur ses valeurs par défaut ferait dépendre l'empreinte du worker de la
 * taille de la base de l'utilisateur.
 */
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 2;

export interface BackupDestination {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle: boolean;
  prefix: string;
  region: string;
  /** En clair. Déchiffré au plus près de l'usage, jamais journalisé. */
  secretAccessKey: string;
}

export class BackupStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupStoreError";
  }
}

function clientFor(destination: BackupDestination): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: destination.accessKeyId,
      secretAccessKey: destination.secretAccessKey,
    },
    endpoint: destination.endpoint,
    forcePathStyle: destination.forcePathStyle,
    region: destination.region,
  });
}

/**
 * Construit la clé d'un objet de sauvegarde.
 *
 * L'id de la sauvegarde y figure, pas seulement l'horodatage : deux
 * sauvegardes de la même base dans la même seconde se recouvriraient
 * silencieusement, et une sauvegarde qui en écrase une autre est précisément
 * ce qu'on ne peut pas se permettre ici.
 */
export function backupObjectKey(opts: {
  backupId: string;
  databaseName: string;
  extension: string;
  prefix: string;
  takenAt: Date;
}): string {
  const stamp = opts.takenAt.toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${opts.backupId}.${opts.extension}`;
  const parts = [opts.prefix, opts.databaseName, name].filter((p) => p !== "");
  return parts.join("/");
}

/**
 * Éprouve une destination pour de bon : un aller-retour complet écriture →
 * lecture → suppression, pas seulement un HEAD sur le compartiment.
 *
 * La distinction compte. Beaucoup de fournisseurs accordent la lecture d'un
 * compartiment à une clé qui ne peut pas y écrire ; un test qui s'arrête au
 * HEAD déclarerait la destination bonne, et l'utilisateur ne le découvrirait
 * qu'à sa première vraie sauvegarde — c'est-à-dire au pire moment, celui où
 * il croit être protégé.
 */
export async function checkDestination(
  destination: BackupDestination
): Promise<void> {
  const client = clientFor(destination);
  const key = [destination.prefix, `.noddle-check-${Date.now()}`]
    .filter((p) => p !== "")
    .join("/");

  try {
    await client.send(new HeadBucketCommand({ Bucket: destination.bucket }));
  } catch (err) {
    throw new BackupStoreError(
      `compartiment « ${destination.bucket} » injoignable : ${describe(err)}`,
      { cause: err }
    );
  }

  try {
    await client.send(
      new PutObjectCommand({
        Body: "noddle",
        Bucket: destination.bucket,
        Key: key,
      })
    );
  } catch (err) {
    throw new BackupStoreError(
      `écriture refusée dans « ${destination.bucket} » : ${describe(err)}`,
      { cause: err }
    );
  }

  try {
    await client.send(
      new DeleteObjectCommand({ Bucket: destination.bucket, Key: key })
    );
  } catch (err) {
    throw new BackupStoreError(
      `suppression refusée dans « ${destination.bucket} » : ${describe(err)} — les anciennes sauvegardes ne pourront pas être purgées`,
      { cause: err }
    );
  }
}

/**
 * Téléverse un flux de taille INCONNUE, en multipart.
 *
 * Renvoie la taille relue par un HEAD, jamais le compte d'octets vus passer :
 * ce qui compte est ce que le compartiment détient, pas ce qu'on croit lui
 * avoir envoyé.
 *
 * Mesuré contre RustFS — si le flux ÉMET une erreur, le SDK annule
 * l'upload multipart : aucun objet n'est publié et aucun envoi ne reste
 * ouvert. Il n'y a donc rien à nettoyer sur ce chemin-là. En revanche un flux
 * qui se termine PROPREMENT mais tronqué produit un objet parfaitement valide
 * au contenu faux, que rien ici ne peut détecter : c'est à l'appelant de lire
 * le code de sortie de son dumper.
 */
export async function uploadStream(
  destination: BackupDestination,
  key: string,
  body: Readable
): Promise<number> {
  const client = clientFor(destination);
  const upload = new Upload({
    client,
    params: { Body: body, Bucket: destination.bucket, Key: key },
    partSize: PART_SIZE,
    queueSize: QUEUE_SIZE,
  });

  await upload.done();
  return await objectSize(destination, key);
}

/** Taille de l'objet, ou `null` s'il n'existe pas. */
export async function objectSize(
  destination: BackupDestination,
  key: string
): Promise<number> {
  const client = clientFor(destination);
  const head = await client.send(
    new HeadObjectCommand({ Bucket: destination.bucket, Key: key })
  );
  return head.ContentLength ?? 0;
}

/**
 * Vrai si l'objet est réellement dans le compartiment.
 *
 * Appelé avant toute restauration : la table `backups` dit ce que Noddle a
 * écrit, le compartiment dit ce qui s'y trouve ENCORE. Quelqu'un a pu purger
 * le seau à la main, et découvrir l'objet manquant APRÈS avoir effacé la base
 * courante serait la pire séquence possible.
 */
export async function objectExists(
  destination: BackupDestination,
  key: string
): Promise<boolean> {
  try {
    await objectSize(destination, key);
    return true;
  } catch (err) {
    if (err instanceof NotFound || err instanceof NoSuchKey) {
      return false;
    }
    throw new BackupStoreError(
      `impossible de vérifier l'objet ${key} : ${describe(err)}`,
      { cause: err }
    );
  }
}

/** Ouvre l'objet en lecture. Le corps est un flux : jamais chargé en mémoire. */
export async function downloadStream(
  destination: BackupDestination,
  key: string
): Promise<Readable> {
  const client = clientFor(destination);
  const res = await client.send(
    new GetObjectCommand({ Bucket: destination.bucket, Key: key })
  );
  if (!res.Body) {
    throw new BackupStoreError(`objet vide ou illisible : ${key}`);
  }
  return res.Body as Readable;
}

export async function deleteObject(
  destination: BackupDestination,
  key: string
): Promise<void> {
  const client = clientFor(destination);
  await client.send(
    new DeleteObjectCommand({ Bucket: destination.bucket, Key: key })
  );
}

/**
 * Message lisible sans faire fuiter la clé secrète.
 *
 * Les erreurs du SDK portent la requête signée dans leurs métadonnées ; les
 * journaliser telles quelles écrirait des identifiants dans les logs.
 */
function describe(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
