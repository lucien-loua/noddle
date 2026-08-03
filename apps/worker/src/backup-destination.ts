// Chargement de la destination S3, déchiffrée au plus près de l'usage.
//
// Fichier à part de `backup.ts` parce que la restauration en a besoin aussi,
// et qu'aucune des deux n'a de raison de dépendre de l'autre.
import type { BackupDestination } from "@noddle/backup-store";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import type { DeployContext } from "#deploy";

/**
 * La destination unique de l'installation.
 *
 * Échoue bruyamment plutôt que de renvoyer `null` : appeler ceci veut dire
 * qu'une sauvegarde est déjà en train de se lancer, et un `null` silencieux se
 * transformerait en `TypeError` illisible trois appels plus loin.
 */
export async function loadDestination(
  ctx: DeployContext
): Promise<BackupDestination> {
  const row = await ctx.db.query.backupDestinations.findFirst();
  if (!row) {
    throw new Error(
      "aucune destination de sauvegarde configurée — renseigner un stockage S3 avant de sauvegarder"
    );
  }
  return {
    accessKeyId: row.accessKeyId,
    bucket: row.bucket,
    endpoint: row.endpoint,
    forcePathStyle: row.forcePathStyle,
    prefix: row.prefix,
    region: row.region,
    // Jamais journalisée, jamais renvoyée : elle ne sort d'ici que vers le
    // signataire du SDK.
    secretAccessKey: decryptSecret(
      row.secretAccessKeyEncrypted,
      ctx.appKey,
      secretContext.backupDestination(row.id)
    ),
  };
}
