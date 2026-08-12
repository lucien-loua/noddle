import { databases, envVars } from "@noddle/db/schema";
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/crypto";
import { attachDatabaseSchema } from "@noddle/shared/validation/database";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded } from "@/lib/permission.server";
import { connectionString } from "./connection-url";

export const attachDatabase = createServerFn({ method: "POST" })
  .validator(attachDatabaseSchema)
  .handler(
    async ({ data }): Promise<{ key: string }> =>
      runGuarded({
        load: () =>
          db.query.databases.findFirst({
            where: eq(databases.id, data.databaseId),
          }),
        notFoundMessage: "database not found",
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
            const id = crypto.randomUUID();
            await db.insert(envVars).values({
              id,
              isSecret: true,
              key: data.envVarKey,
              serviceId: data.serviceId,
              valueEncrypted: encryptSecret(
                value,
                env.appKey,
                secretContext.envVar(id)
              ),
            });
          }

          return { key: data.envVarKey };
        },
        // The Database attached to, never the connection string — it
        // carries the root password.
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );
