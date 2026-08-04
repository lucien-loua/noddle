// Sauvegardes automatiques et purge des anciennes.
//
// Pas un planificateur BullMQ par base, mais UN passage qui interroge la base
// de données. La différence compte : un planificateur par base devrait être
// créé, modifié et supprimé à chaque fois que l'utilisateur touche au réglage,
// et le jour où Redis est vidé — ce qui arrive, c'est un cache — toutes les
// planifications disparaîtraient en silence. Ici l'état vit dans Postgres, et
// un passage qui redémarre reprend exactement où il en était.
//
// Même forme que `sweepWatch`, pour la même raison : module séparé d'index.ts
// pour être testable sans démarrer le processus.
import { backupObjectKey, deleteObject } from "@noddle/backup-store";
import { backups, databases } from "@noddle/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { loadDestination } from "#backup-destination";
import type { DeployContext } from "#deploy";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const INTERVALS: Record<string, number> = {
  daily: DAY_MS,
  weekly: WEEK_MS,
};

export interface BackupSweepResult {
  /** Objets purgés au titre de la rétention. */
  pruned: string[];
  /** Sauvegardes déposées en file par ce passage. */
  queued: string[];
}

/**
 * Une base est due si sa dernière sauvegarde RÉUSSIE remonte à plus que son
 * intervalle.
 *
 * « Réussie » et pas « tentée » : sinon une base cassée arrêterait d'être
 * sauvegardée dès le premier échec, exactement quand on en a le plus besoin.
 * Le revers assumé est qu'une base durablement en panne réessaiera à chaque
 * passage — c'est le bon sens du compromis, et le statut `failed` reste
 * visible dans l'historique.
 */
export async function sweepBackups(
  ctx: DeployContext,
  enqueue: (backupId: string) => Promise<unknown>
): Promise<BackupSweepResult> {
  const result: BackupSweepResult = { pruned: [], queued: [] };

  const destination = await ctx.db.query.backupDestinations.findFirst();
  if (!destination) {
    // Aucune destination configurée : il n'y a rien à planifier, et échouer
    // bruyamment à chaque passage noierait les vraies erreurs.
    return result;
  }

  const scheduled = await ctx.db.query.databases.findMany({
    where: and(eq(databases.status, "running")),
  });

  for (const database of scheduled) {
    if (database.backupSchedule === "off") {
      continue;
    }
    const interval = INTERVALS[database.backupSchedule];
    if (!interval) {
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: une base à la fois, volontairement
    const last = await ctx.db.query.backups.findFirst({
      orderBy: desc(backups.createdAt),
      where: and(
        eq(backups.databaseId, database.id),
        eq(backups.status, "completed")
      ),
    });

    // Une sauvegarde déjà en vol ne doit pas en déclencher une seconde : deux
    // dumps simultanés de la même base se disputeraient le disque du serveur.
    const inFlight = await ctx.db.query.backups.findFirst({
      where: and(
        eq(backups.databaseId, database.id),
        eq(backups.status, "running")
      ),
    });
    if (inFlight) {
      continue;
    }

    const due = !last || Date.now() - last.createdAt.getTime() >= interval;
    if (!due) {
      continue;
    }

    const [created] = await ctx.db
      .insert(backups)
      .values({
        databaseId: database.id,
        kind: "scheduled",
        objectKey: backupObjectKey({
          backupId: crypto.randomUUID(),
          databaseName: database.name,
          extension: database.engine === "postgres" ? "dump" : "rdb",
          prefix: destination.prefix,
          takenAt: new Date(),
        }),
      })
      .returning();
    if (created) {
      await enqueue(created.id);
      result.queued.push(created.id);
    }
  }

  return result;
}

/**
 * Purge les sauvegardes réussies au-delà de la rétention de la base.
 *
 * Appelée APRÈS une sauvegarde réussie, jamais avant : purger d'abord
 * réduirait la fenêtre pendant laquelle on a encore quelque chose à restaurer
 * si le dump qui suit échoue.
 *
 * L'objet est retiré du compartiment ET la ligne de la base. Un objet dont la
 * suppression échoue laisse sa ligne en place plutôt que de créer une ligne
 * qui prétend exister sans objet — c'est le sens de lecture qui protège :
 * mieux vaut un objet orphelin qu'une sauvegarde fantôme proposée à la
 * restauration.
 */
export async function pruneBackups(
  ctx: DeployContext,
  databaseId: string
): Promise<string[]> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
  });
  if (!database) {
    return [];
  }

  const kept = await ctx.db.query.backups.findMany({
    orderBy: desc(backups.createdAt),
    where: and(
      eq(backups.databaseId, databaseId),
      eq(backups.status, "completed")
    ),
  });
  const excess = kept.slice(database.backupRetention);
  if (excess.length === 0) {
    return [];
  }

  const destination = await loadDestination(ctx);
  const removed: string[] = [];

  for (const backup of excess) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: suppression séquentielle volontaire
      await deleteObject(destination, backup.objectKey);
    } catch {
      // L'objet a pu être purgé à la main. On continue : la ligne doit partir
      // de toute façon, sinon elle réapparaîtra comme restaurable alors que
      // son objet n'existe plus.
    }
    await ctx.db.delete(backups).where(eq(backups.id, backup.id));
    removed.push(backup.objectKey);
  }

  return removed;
}
