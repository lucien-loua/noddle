// Relecture d'un déploiement TERMINÉ.
//
// Redis ne garde que la fenêtre chaude ; l'intégralité vit dans le fichier que
// le worker a écrit, dont `deployment_logs.storage_url` est le pointeur. La
// colonne est une URL précisément pour que S3 remplace le disque plus tard
// sans migration.
import { open, stat } from "node:fs/promises";
import { deploymentLogs } from "@noddle/db/schema";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";

/**
 * Un build Next.js produit des dizaines de milliers de lignes. Renvoyer le
 * fichier entier bloquerait l'onglet ; c'est la FIN qui dit pourquoi un
 * déploiement s'est terminé comme il s'est terminé.
 */
const MAX_TAIL_BYTES = 1024 * 1024;

export async function readArchive(
  deploymentId: string
): Promise<string | null> {
  const [pointer] = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, deploymentId))
    .orderBy(desc(deploymentLogs.createdAt))
    .limit(1);

  if (!pointer?.storageUrl.startsWith("file://")) {
    return null;
  }
  const path = pointer.storageUrl.slice("file://".length);

  try {
    const { size } = await stat(path);
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      return start > 0 ? `… ${start} octets antérieurs omis …\n${text}` : text;
    } finally {
      await handle.close();
    }
  } catch {
    // Fichier absent : le worker tourne peut-être sur une autre machine, ou
    // le volume n'est pas monté. On le dit plutôt que de rendre un flux vide
    // qui ressemblerait à un build sans sortie.
    return null;
  }
}
