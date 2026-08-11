import { databases, envVars } from "@noddle/db/schema";
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/shared/crypto";
import { attachDatabaseSchema } from "@noddle/shared/validation/database";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { requirePermission } from "@/lib/permission.server";
import { connectionString } from "./connection-url";

export const attachDatabase = createServerFn({ method: "POST" })
  .validator(attachDatabaseSchema)
  .handler(async ({ data }): Promise<{ key: string }> => {
    await requirePermission({ action: "attach", resource: "database" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }

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
  });
