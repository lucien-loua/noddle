import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { envVars, serviceDependencies } from "@noddle/db/schema";
import { attachDatabaseSchema } from "@noddle/shared/validation/database";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";

import { connectionString } from "./connection-url";

export const attachDatabase = createServerFn({ method: "POST" })
  .validator(attachDatabaseSchema)
  .handler(async ({ data }): Promise<{ key: string }> =>
    runGuarded({
      ...guarded.database(data.databaseId),
      permission: { action: "attach", resource: "database" },
      run: async ({ row: database }) => {
        const password = decryptSecret(
          database.rootPasswordEncrypted,
          env.appKey,
          secretContext.databasePassword(database.id)
        );
        const host = database.swarmName;
        const value = connectionString(
          database.engine,
          host,
          password,
          database.rootUser,
          database.databaseName
        );

        const existing = await db.query.envVars.findFirst({
          where: and(
            eq(envVars.serviceId, data.serviceId),
            eq(envVars.key, data.envVarKey)
          ),
        });

        const envVarId = existing?.id ?? crypto.randomUUID();
        if (existing) {
          await db
            .update(envVars)
            .set({
              isSecret: true,
              updatedAt: new Date(),
              valueEncrypted: encryptSecret(
                value,
                env.appKey,
                secretContext.envVar(existing.id)
              ),
            })
            .where(eq(envVars.id, existing.id));
        } else {
          await db.insert(envVars).values({
            id: envVarId,
            isSecret: true,
            key: data.envVarKey,
            serviceId: data.serviceId,
            valueEncrypted: encryptSecret(
              value,
              env.appKey,
              secretContext.envVar(envVarId)
            ),
          });
        }

        await db
          .insert(serviceDependencies)
          .values({
            dependsOnDatabaseId: database.id,
            envVarId,
            serviceId: data.serviceId,
          })
          .onConflictDoUpdate({
            set: { envVarId },
            target: [
              serviceDependencies.serviceId,
              serviceDependencies.dependsOnDatabaseId,
            ],
            targetWhere: isNotNull(serviceDependencies.dependsOnDatabaseId),
          });

        return { key: data.envVarKey };
      },
      target: identityTarget,
    })
  );
