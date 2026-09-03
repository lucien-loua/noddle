import { decryptSecret, secretContext } from "@noddle/crypto";
import { databases } from "@noddle/db/schema";
import { DATABASE_PORT } from "@noddle/shared/database-spec";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runRead } from "@/lib/permission.server";

import { connectionString, maskedConnectionString } from "./connection-url";

export interface DatabaseCredentials {
  connectionUrl: string;
  databaseName: string | null;
  externalConnectionUrl: string | null;
  host: string;
  maskedConnectionUrl: string;
  maskedExternalConnectionUrl: string | null;
  password: string;
  port: number;
  user: string | null;
}

export const getDatabaseCredentials = createServerFn({ method: "GET" })
  .validator((data: { databaseId: string }) => data)
  .handler(async ({ data }): Promise<DatabaseCredentials> =>
    runRead({
      load: () =>
        db.query.databases.findFirst({
          where: eq(databases.id, data.databaseId),
          with: { server: true },
        }),
      notFoundMessage: "database not found",
      permission: { action: "read", resource: "envVar" },
      read: ({ row: database }) => {
        const password = decryptSecret(
          database.rootPasswordEncrypted,
          env.appKey,
          secretContext.databasePassword(database.id)
        );
        const host = database.swarmName;

        return {
          connectionUrl: connectionString(
            database.engine,
            host,
            password,
            database.rootUser,
            database.databaseName
          ),
          databaseName: database.databaseName ?? database.rootUser,
          externalConnectionUrl: database.externalPort
            ? connectionString(
                database.engine,
                database.server.host,
                password,
                database.rootUser,
                database.databaseName,
                database.externalPort
              )
            : null,
          host,
          maskedConnectionUrl: maskedConnectionString(
            database.engine,
            host,
            database.rootUser,
            database.databaseName
          ),
          maskedExternalConnectionUrl: database.externalPort
            ? maskedConnectionString(
                database.engine,
                database.server.host,
                database.rootUser,
                database.databaseName,
                database.externalPort
              )
            : null,
          password,
          port: DATABASE_PORT[database.engine],
          user: database.rootUser,
        };
      },
    })
  );
