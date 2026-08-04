// Sauvegardes : destination S3, déclenchement, historique, restauration.
//
// Le web ne sauvegarde RIEN lui-même — il dépose un job, comme pour un
// déploiement. Une seule exception assumée : « Tester », qui parle à S3
// directement. C'est un aller-retour de quelques centaines de millisecondes,
// et le faire passer par la file obligerait le formulaire à sonder un job
// pour afficher « ça marche », ce qui est une bien pire expérience que
// l'attente qu'on évite.

import { backupObjectKey, checkDestination } from "@noddle/backup-store";
import { backupDestinations, backups, databases } from "@noddle/db/schema";
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/shared/crypto";
import {
  backupDestinationSchema,
  backupRequestSchema,
  backupScheduleRequestSchema,
  restoreRequestSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

/**
 * La destination telle qu'elle revient au navigateur : SANS la clé secrète.
 *
 * Elle n'est jamais renvoyée, même chiffrée, même une fois — comme le mot de
 * passe d'une base. Le formulaire de modification part donc avec un champ
 * secret vide, et le laisser vide conserve la clé existante.
 */
export interface DestinationRow {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle: boolean;
  id: string;
  prefix: string;
  region: string;
}

export interface BackupRow {
  createdAt: string;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  kind: "manual" | "pre_restore" | "scheduled";
  sizeBytes: number;
  status: "completed" | "failed" | "queued" | "running";
}

export const getDestination = createServerFn({ method: "GET" }).handler(
  async (): Promise<DestinationRow | null> => {
    await requireSession();
    const row = await db.query.backupDestinations.findFirst();
    if (!row) {
      return null;
    }
    return {
      accessKeyId: row.accessKeyId,
      bucket: row.bucket,
      endpoint: row.endpoint,
      forcePathStyle: row.forcePathStyle,
      id: row.id,
      prefix: row.prefix,
      region: row.region,
    };
  }
);

/**
 * Enregistre la destination unique de l'installation.
 *
 * Elle est ÉPROUVÉE avant d'être écrite : un aller-retour écriture → lecture →
 * suppression contre le vrai service. Enregistrer d'abord et découvrir à la
 * première sauvegarde nocturne que la clé n'a pas le droit d'écrire est
 * exactement le scénario où l'utilisateur se croyait protégé.
 */
export const saveDestination = createServerFn({ method: "POST" })
  .validator(backupDestinationSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const existing = await db.query.backupDestinations.findFirst();

    // Un secret vide sur une destination déjà enregistrée veut dire « garde
    // celle d'avant » : le formulaire ne peut pas la réafficher pour la
    // renvoyer, puisqu'elle n'en sort jamais.
    let secret = data.secretAccessKey;
    if (secret === "" && existing) {
      secret = decryptSecret(
        existing.secretAccessKeyEncrypted,
        env.appKey,
        secretContext.backupDestination(existing.id)
      );
    }

    await checkDestination({
      accessKeyId: data.accessKeyId,
      bucket: data.bucket,
      endpoint: data.endpoint,
      forcePathStyle: data.forcePathStyle,
      prefix: data.prefix,
      region: data.region,
      secretAccessKey: secret,
    });

    if (existing) {
      await db
        .update(backupDestinations)
        .set({
          accessKeyId: data.accessKeyId,
          bucket: data.bucket,
          endpoint: data.endpoint,
          forcePathStyle: data.forcePathStyle,
          prefix: data.prefix,
          region: data.region,
          secretAccessKeyEncrypted: encryptSecret(
            secret,
            env.appKey,
            secretContext.backupDestination(existing.id)
          ),
          updatedAt: new Date(),
        })
        .where(eq(backupDestinations.id, existing.id));
      return { id: existing.id };
    }

    // Le chiffrement est lié à l'id de la ligne (AAD), donc la ligne doit
    // exister avant d'être chiffrée : insertion puis mise à jour, comme pour
    // une clé SSH de serveur.
    const [created] = await db
      .insert(backupDestinations)
      .values({
        accessKeyId: data.accessKeyId,
        bucket: data.bucket,
        endpoint: data.endpoint,
        forcePathStyle: data.forcePathStyle,
        prefix: data.prefix,
        region: data.region,
        secretAccessKeyEncrypted: "placeholder",
      })
      .returning();
    if (!created) {
      throw new Error("création de la destination impossible");
    }
    await db
      .update(backupDestinations)
      .set({
        secretAccessKeyEncrypted: encryptSecret(
          secret,
          env.appKey,
          secretContext.backupDestination(created.id)
        ),
      })
      .where(eq(backupDestinations.id, created.id));
    return { id: created.id };
  });

/**
 * Le réglage automatique d'une base.
 *
 * Pas de server function de lecture séparée : le dashboard charge déjà les
 * bases, donc `DatabaseRow` porte ces deux champs et une requête de moins
 * part au chargement.
 */
export const saveBackupSchedule = createServerFn({ method: "POST" })
  .validator(backupScheduleRequestSchema)
  .handler(async ({ data }): Promise<{ saved: true }> => {
    await requirePermission({ action: "create", resource: "backup" });

    // Une planification sans destination ne se déclencherait jamais et
    // l'utilisateur croirait être protégé — le pire état possible. On le dit
    // au moment où il l'active, pas au moment où il en aurait eu besoin.
    const destination = await db.query.backupDestinations.findFirst();
    if (!destination && data.schedule !== "off") {
      throw new Error(
        "aucune destination S3 configurée — une sauvegarde planifiée ne partirait nulle part"
      );
    }

    await db
      .update(databases)
      .set({
        backupRetention: data.retention,
        backupSchedule: data.schedule,
        updatedAt: new Date(),
      })
      .where(eq(databases.id, data.databaseId));
    return { saved: true };
  });

export const getBackups = createServerFn({ method: "GET" })
  .validator(backupRequestSchema)
  .handler(async ({ data }): Promise<BackupRow[]> => {
    await requireSession();
    const rows = await db.query.backups.findMany({
      limit: 20,
      orderBy: desc(backups.createdAt),
      where: eq(backups.databaseId, data.databaseId),
    });
    return rows.map((b) => ({
      createdAt: b.createdAt.toISOString(),
      errorMessage: b.errorMessage,
      finishedAt: b.finishedAt?.toISOString() ?? null,
      id: b.id,
      kind: b.kind,
      sizeBytes: b.sizeBytes,
      status: b.status,
    }));
  });

/**
 * Déclenche une sauvegarde.
 *
 * La clé d'objet est décidée ICI, avant le job : si le worker meurt entre les
 * deux, on sait toujours quel objet la ligne prétendait produire.
 */
export const triggerBackup = createServerFn({ method: "POST" })
  .validator(backupRequestSchema)
  .handler(async ({ data }): Promise<{ backupId: string }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("base de données introuvable");
    }
    const destination = await db.query.backupDestinations.findFirst();
    if (!destination) {
      throw new Error(
        "aucune destination S3 configurée — renseignez-en une avant de sauvegarder"
      );
    }

    const [created] = await db
      .insert(backups)
      .values({
        databaseId: database.id,
        kind: "manual",
        objectKey: backupObjectKey({
          backupId: crypto.randomUUID(),
          databaseName: database.name,
          extension: database.engine === "postgres" ? "dump" : "rdb",
          prefix: destination.prefix,
          takenAt: new Date(),
        }),
      })
      .returning();
    if (!created) {
      throw new Error("création de la sauvegarde impossible");
    }

    await enqueueDeploy({ backupId: created.id, kind: "backup" });
    return { backupId: created.id };
  });

/**
 * Déclenche une restauration.
 *
 * `confirmName` est vérifié ICI, pas seulement dans la boîte de dialogue. Un
 * garde-fou qui ne vit que dans le composant ne protège que les clients qui
 * l'affichent ; c'est la seule opération du produit qui détruit des données,
 * donc elle se refuse côté serveur.
 */
export const triggerRestore = createServerFn({ method: "POST" })
  .validator(restoreRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission({ action: "restore", resource: "backup" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("base de données introuvable");
    }
    if (data.confirmName !== database.name) {
      throw new Error(
        `le nom saisi ne correspond pas à « ${database.name} » — restauration annulée`
      );
    }

    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, data.backupId),
    });
    if (!backup || backup.databaseId !== database.id) {
      throw new Error("sauvegarde introuvable pour cette base");
    }
    if (backup.status !== "completed") {
      throw new Error(
        "seule une sauvegarde complète peut être restaurée — celle-ci ne l'est pas"
      );
    }

    await enqueueDeploy({
      backupId: backup.id,
      databaseId: database.id,
      kind: "restore",
    });
    return { queued: true };
  });
