import { databases, envVars } from "@noddle/db/schema";
import {
  decryptSecret,
  encryptSecret,
  isRetainedSecret,
  secretContext,
} from "@noddle/crypto";
import { ENGINE_ENV_PREFIX } from "@noddle/database-spec";
import { envVarKeySchema } from "@noddle/shared/validation/env-var";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db.server";
import { queueDatabaseProvision } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { runGuarded, runRead } from "@/lib/permission.server";

/**
 * WHO owns these variables: a service, or a database.
 *
 * Exactly one of the two, and it's the table's `check` constraint that
 * guarantees it as a last resort — here we only reject early, with a
 * readable message, rather than letting Postgres answer with a constraint
 * name.
 */
export const envVarTargetSchema = z
  .object({
    databaseId: z.uuid().optional(),
    serviceId: z.uuid().optional(),
  })
  .refine(
    (t) => Boolean(t.serviceId) !== Boolean(t.databaseId),
    "give exactly one of serviceId or databaseId"
  );

export type EnvVarTarget = z.infer<typeof envVarTargetSchema>;

/**
 * The ownership predicate.
 *
 * `isNull` on the OTHER column isn't decorative: without it, a query on
 * `service_id` alone would stay correct today but become wrong the day a
 * join widens the read. We say exactly what we want to read.
 */
function ownedBy(target: EnvVarTarget) {
  return target.serviceId
    ? and(eq(envVars.serviceId, target.serviceId), isNull(envVars.databaseId))
    : and(
        eq(envVars.databaseId, target.databaseId ?? ""),
        isNull(envVars.serviceId)
      );
}

export interface EnvVarView {
  id: string;
  isSecret: boolean;
  key: string;
  /** `null` for a secret — never decrypted toward the client. */
  value: string | null;
}

export const getEnvVars = createServerFn({ method: "GET" })
  .validator((data: EnvVarTarget) => envVarTargetSchema.parse(data))
  .handler(
    async ({ data }): Promise<EnvVarView[]> =>
      runRead({
        permission: { action: "read", resource: "envVar" },
        read: async () => {
          const rows = await db.query.envVars.findMany({
            orderBy: envVars.key,
            where: ownedBy(data),
          });

          return rows.map((row) => ({
            id: row.id,
            isSecret: row.isSecret,
            key: row.key,
            // Non-secret values are encrypted at rest too — a single code path,
            // so no oversight is possible — but nothing forbids returning them to
            // an authenticated administrator. It's `isSecret` that decides, not
            // the storage mode.
            value: row.isSecret
              ? null
              : decryptSecret(
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
  /** `null` = keep the value already stored. */
  value: z.string().max(65_536).nullable(),
});

const saveEnvVarsSchema = z.intersection(
  envVarTargetSchema,
  z.object({ vars: z.array(envVarWriteSchema).max(500) })
);

export interface EnvVarSaveResult {
  added: string[];
  removed: string[];
  updated: string[];
}

/**
 * Reject a key RESERVED for the engine, rather than store it and watch the
 * worker ignore it.
 *
 * Both behaviors protect the database; only one of them SAYS SO. Without
 * this check, the variable would show up in the table, with no effect
 * whatsoever, and the screen would claim a configuration that isn't
 * actually running.
 */
async function assertNoReservedKeys(
  databaseId: string,
  vars: Array<{ key: string }>
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

function isEnvValueRetained(isSecret: boolean, value: string | null): boolean {
  return isSecret ? isRetainedSecret(value) : value === null;
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
    const valueRetained = isEnvValueRetained(incoming.isSecret, plaintext);
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
  if (isEnvValueRetained(incoming.isSecret, plaintext) || plaintext === null) {
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
  .handler(
    async ({ data }): Promise<EnvVarSaveResult> =>
      // No `target`: this writes, updates and deletes many rows under one
      // owner, so no single envVar id is the object. The line still records
      // who wrote variables and when, which is the part that matters.
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
          // The ownership columns, resolved ONCE: `?? null` repeated in the
          // insertion loop would be two extra branches on every iteration for a
          // value that never changes.
          const owner = {
            databaseId: data.databaseId ?? null,
            serviceId: data.serviceId ?? null,
          };

          // All or nothing. The user approved ONE diff: if the twelfth variable
          // fails, applying the first eleven would leave the service in a state
          // nobody asked for — and one that would ship as-is at the next
          // deployment.
          await db.transaction(async (tx) => {
            const existing = await tx.query.envVars.findMany({
              where: ownedBy(data),
            });
            const byKey = new Map(existing.map((row) => [row.key, row]));

            for (const incoming of data.vars) {
              // biome-ignore lint/performance/noAwaitInLoops: ordered writes within a transaction
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

          // A database has NO Deploy button: without this job, the variables
          // would stay in the database without ever reaching the container, and
          // the screen would show a configuration that isn't running anywhere. A
          // service, on the other hand, will pick them up on its next deployment
          // — that's the action the user takes anyway.
          //
          // Nothing is queued when NOTHING changed: restarting a database for an
          // empty save would be a pointless outage.
          const changed =
            result.added.length +
              result.removed.length +
              result.updated.length >
            0;
          if (data.databaseId && changed) {
            await queueDatabaseProvision(data.databaseId);
          }

          return result;
        },
      })
  );
