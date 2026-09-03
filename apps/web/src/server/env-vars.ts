import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { databases, envVars, serviceDependencies } from "@noddle/db/schema";
import type { DatabaseEngine } from "@noddle/shared/database-spec";
import { ENGINE_ENV_PREFIX } from "@noddle/shared/database-spec";
import { envVarKeySchema } from "@noddle/shared/validation/env-var";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db.server";
import { queueDatabaseProvision } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { runGuarded, runRead } from "@/lib/permission.server";

export const envVarTargetSchema = z
  .object({
    databaseId: z.uuid("Choose a database.").optional(),
    serviceId: z.uuid("Choose a service.").optional(),
  })
  .refine(
    (t) => Boolean(t.serviceId) !== Boolean(t.databaseId),
    "give exactly one of serviceId or databaseId"
  );

export type EnvVarTarget = z.infer<typeof envVarTargetSchema>;

function ownedBy(target: EnvVarTarget) {
  return target.serviceId
    ? and(eq(envVars.serviceId, target.serviceId), isNull(envVars.databaseId))
    : and(
        eq(envVars.databaseId, target.databaseId ?? ""),
        isNull(envVars.serviceId)
      );
}

export interface EnvVarAttachment {
  databaseId: string;
  engine: DatabaseEngine;
  environmentId: string;
  name: string;
  projectId: string;
}

export interface EnvVarView {
  attachedFrom: EnvVarAttachment | null;
  id: string;
  isSecret: boolean;
  key: string;
  value: string;
}

export const getEnvVars = createServerFn({ method: "GET" })
  .validator((data: EnvVarTarget) => envVarTargetSchema.parse(data))
  .handler(async ({ data }): Promise<EnvVarView[]> =>
    runRead({
      permission: { action: "read", resource: "envVar" },
      read: async () => {
        const rows = await db.query.envVars.findMany({
          orderBy: envVars.key,
          where: ownedBy(data),
        });

        const edges =
          data.serviceId && rows.length > 0
            ? await db.query.serviceDependencies.findMany({
                where: inArray(
                  serviceDependencies.envVarId,
                  rows.map((row) => row.id)
                ),
                with: {
                  dependsOnDatabase: {
                    with: { environment: true },
                  },
                },
              })
            : [];
        const attached = new Map(
          edges.flatMap((edge): [string, EnvVarAttachment][] => {
            const database = edge.dependsOnDatabase;
            if (!(edge.envVarId && database?.environment)) {
              return [];
            }
            return [
              [
                edge.envVarId,
                {
                  databaseId: database.id,
                  engine: database.engine,
                  environmentId: database.environmentId,
                  name: database.name,
                  projectId: database.environment.projectId,
                },
              ],
            ];
          })
        );

        return rows.map((row) => ({
          attachedFrom: attached.get(row.id) ?? null,
          id: row.id,
          isSecret: row.isSecret,
          key: row.key,
          value: decryptSecret(
            row.valueEncrypted,
            env.appKey,
            secretContext.envVar(row.id)
          ),
        }));
      },
    })
  );

const envVarWriteSchema = z.object({
  isSecret: z.boolean(),
  key: envVarKeySchema,
  value: z
    .string()
    .max(65_536, "Keep the value under 65536 characters.")
    .nullable(),
});

const saveEnvVarsSchema = z.intersection(
  envVarTargetSchema,
  z.object({
    vars: z.array(envVarWriteSchema).max(500, "Save 500 variables or fewer."),
  })
);

export interface EnvVarSaveResult {
  added: string[];
  removed: string[];
  updated: string[];
}

async function assertNoReservedKeys(
  databaseId: string,
  vars: { key: string }[]
): Promise<void> {
  const database = await db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
  });
  if (!database) {
    throw new Error("database not found");
  }
  const prefix = ENGINE_ENV_PREFIX[database.engine];
  const reserved = vars.filter((v) => v.key.startsWith(prefix));
  if (reserved.length > 0) {
    throw new Error(
      `${reserved.map((v) => v.key).join(", ")}: ${prefix}* is set by Noddle from this database's own settings`
    );
  }
}

function isEnvValueRetained(value: string | null): boolean {
  return value === null;
}

type EnvVarWrite = z.infer<typeof envVarWriteSchema>;

interface EnvVarTx {
  insert: typeof db.insert;
  update: typeof db.update;
}

async function writeEnvVar(
  tx: EnvVarTx,
  incoming: EnvVarWrite,
  current: { id: string; isSecret: boolean } | undefined,
  owner: { databaseId: string | null; serviceId: string | null },
  result: EnvVarSaveResult
): Promise<void> {
  if (current) {
    const plaintext = incoming.value;
    const flagChanged = current.isSecret !== incoming.isSecret;
    const valueRetained = isEnvValueRetained(plaintext);
    if (valueRetained && !flagChanged) {
      return;
    }

    await tx
      .update(envVars)
      .set({
        isSecret: incoming.isSecret,
        updatedAt: new Date(),
        ...(valueRetained || plaintext === null
          ? {}
          : {
              valueEncrypted: encryptSecret(
                plaintext,
                env.appKey,
                secretContext.envVar(current.id)
              ),
            }),
      })
      .where(eq(envVars.id, current.id));
    result.updated.push(incoming.key);
    return;
  }

  const plaintext = incoming.value;
  if (isEnvValueRetained(plaintext) || plaintext === null) {
    throw new Error(`${incoming.key} is a new variable: it needs a value`);
  }
  const id = crypto.randomUUID();
  await tx.insert(envVars).values({
    ...owner,
    id,
    isSecret: incoming.isSecret,
    key: incoming.key,
    valueEncrypted: encryptSecret(
      plaintext,
      env.appKey,
      secretContext.envVar(id)
    ),
  });
  result.added.push(incoming.key);
}

export const saveEnvVars = createServerFn({ method: "POST" })
  .validator(saveEnvVarsSchema)
  .handler(async ({ data }): Promise<EnvVarSaveResult> =>
    runGuarded({
      permission: { action: "write", resource: "envVar" },
      run: async () => {
        if (data.databaseId) {
          await assertNoReservedKeys(data.databaseId, data.vars);
        }

        const seen = new Set<string>();
        for (const v of data.vars) {
          if (seen.has(v.key)) {
            throw new Error(`duplicate key: ${v.key}`);
          }
          seen.add(v.key);
        }

        const result: EnvVarSaveResult = {
          added: [],
          removed: [],
          updated: [],
        };
        const owner = {
          databaseId: data.databaseId ?? null,
          serviceId: data.serviceId ?? null,
        };

        await db.transaction(async (tx) => {
          const existing = await tx.query.envVars.findMany({
            where: ownedBy(data),
          });
          const byKey = new Map(existing.map((row) => [row.key, row]));

          for (const incoming of data.vars) {
            await writeEnvVar(
              tx,
              incoming,
              byKey.get(incoming.key),
              owner,
              result
            );
          }

          const removed = existing.filter((row) => !seen.has(row.key));
          if (removed.length > 0) {
            await tx.delete(envVars).where(
              and(
                ownedBy(data),
                inArray(
                  envVars.id,
                  removed.map((row) => row.id)
                )
              )
            );
            result.removed = removed.map((row) => row.key);
          }
        });

        const changed =
          result.added.length + result.removed.length + result.updated.length >
          0;
        if (data.databaseId && changed) {
          await queueDatabaseProvision(data.databaseId);
        }

        return result;
      },
    })
  );
