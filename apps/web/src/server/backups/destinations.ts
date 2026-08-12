import { resolveDestinationSecret } from "@noddle/backup";
import { checkDestination } from "@noddle/backup-store";
import { backupConfigs, backups, s3Destinations } from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/crypto";
import {
  destinationIdSchema,
  s3DestinationCreateSchema,
  s3DestinationSchema,
} from "@noddle/shared/validation/backup";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

function parseDestinationInput(data: unknown) {
  const parsed = s3DestinationSchema.parse(data);
  if (!parsed.id) {
    return s3DestinationCreateSchema.parse(data);
  }
  return parsed;
}

/**
 * The destination as it comes back to the browser: WITHOUT the secret key.
 *
 * It's never sent back, not even encrypted, not even once — like a
 * database's password. The edit form therefore starts with an empty secret
 * field, and leaving it empty keeps the existing key.
 */
export interface DestinationRow {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle: boolean;
  id: string;
  name: string;
  prefix: string;
  region: string;
}

export const getDestinations = createServerFn({ method: "GET" }).handler(
  async (): Promise<DestinationRow[]> => {
    await requireSession();
    const rows = await db.query.s3Destinations.findMany({
      orderBy: s3Destinations.name,
    });
    return rows.map((row) => ({
      accessKeyId: row.accessKeyId,
      bucket: row.bucket,
      endpoint: row.endpoint,
      forcePathStyle: row.forcePathStyle,
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      region: row.region,
    }));
  }
);

/**
 * Removes a destination.
 *
 * REFUSED as long as a backup run OR a config points to it.
 */
export const deleteDestination = createServerFn({ method: "POST" })
  .validator(destinationIdSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.s3Destinations.findFirst({
            where: eq(s3Destinations.id, data.id),
          }),
        notFoundMessage: "destination not found",
        permission: { action: "create", resource: "backup" },
        run: async ({ row }) => {
          const heldRun = await db.query.backups.findFirst({
            where: eq(backups.destinationId, data.id),
          });
          if (heldRun) {
            throw new Error(
              "This destination still holds backups. Delete them first, or they could never be restored."
            );
          }
          const heldConfig = await db.query.backupConfigs.findFirst({
            where: eq(backupConfigs.destinationId, data.id),
          });
          if (heldConfig) {
            throw new Error(
              "This destination is still used by a backup config. Delete the config first."
            );
          }

          await db.delete(s3Destinations).where(eq(s3Destinations.id, row.id));
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );

export const testDestination = createServerFn({ method: "POST" })
  .validator(parseDestinationInput)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        permission: { action: "create", resource: "backup" },
        run: async () => {
          const secret = await resolveDestinationSecret(db, env.appKey, data);
          await checkDestination({
            accessKeyId: data.accessKeyId,
            bucket: data.bucket,
            endpoint: data.endpoint,
            forcePathStyle: data.forcePathStyle,
            prefix: data.prefix,
            region: data.region,
            secretAccessKey: secret,
          });
          return { ok: true as const };
        },
        target: () => ({ id: data.id ?? data.bucket, name: data.bucket }),
      })
  );

export const saveDestination = createServerFn({ method: "POST" })
  .validator(parseDestinationInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const guarded = await runGuarded({
      permission: { action: "create", resource: "backup" },
      run: async () => {
        const secret = await resolveDestinationSecret(db, env.appKey, data);

        await checkDestination({
          accessKeyId: data.accessKeyId,
          bucket: data.bucket,
          endpoint: data.endpoint,
          forcePathStyle: data.forcePathStyle,
          prefix: data.prefix,
          region: data.region,
          secretAccessKey: secret,
        });

        if (data.id) {
          await db
            .update(s3Destinations)
            .set({
              accessKeyId: data.accessKeyId,
              bucket: data.bucket,
              endpoint: data.endpoint,
              forcePathStyle: data.forcePathStyle,
              name: data.name,
              prefix: data.prefix,
              region: data.region,
              secretAccessKeyEncrypted: encryptSecret(
                secret,
                env.appKey,
                secretContext.backupDestination(data.id)
              ),
              updatedAt: new Date(),
            })
            .where(eq(s3Destinations.id, data.id));
          return { id: data.id, name: data.name };
        }

        const [created] = await db
          .insert(s3Destinations)
          .values({
            accessKeyId: data.accessKeyId,
            bucket: data.bucket,
            endpoint: data.endpoint,
            forcePathStyle: data.forcePathStyle,
            name: data.name,
            prefix: data.prefix,
            region: data.region,
            secretAccessKeyEncrypted: "placeholder",
          })
          .returning();
        if (!created) {
          throw new Error("could not create destination");
        }
        await db
          .update(s3Destinations)
          .set({
            secretAccessKeyEncrypted: encryptSecret(
              secret,
              env.appKey,
              secretContext.backupDestination(created.id)
            ),
          })
          .where(eq(s3Destinations.id, created.id));
        return { id: created.id, name: created.name };
      },
      target: ({ result }) => ({ id: result.id, name: result.name }),
    });
    return { id: guarded.id };
  });
