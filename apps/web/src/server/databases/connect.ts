import { databases, environments, projects } from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  DEFAULT_DATABASE_IMAGE,
  DEFAULT_DATABASE_USER,
  HAS_NAMED_DATABASE,
} from "@noddle/shared/database-engines";
import { generateDatabasePassword } from "@noddle/shared/password";
import { newDatabaseSwarmName } from "@noddle/shared/swarm-names";
import { connectDatabaseSchema } from "@noddle/shared/validation/database";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

const NON_IDENTIFIER = /[^a-z0-9_]/g;
const STARTS_LEGALLY = /^[a-z_]/;

function defaultIdentifier(serviceName: string): string {
  const folded = serviceName.toLowerCase().replace(NON_IDENTIFIER, "_");
  return STARTS_LEGALLY.test(folded) ? folded : `db_${folded}`;
}

export const connectDatabase = createServerFn({ method: "POST" })
  .validator(connectDatabaseSchema)
  .handler(async ({ data }): Promise<{ databaseId: string }> => {
    // The Database is the object; the Project and Environment are
    // find-or-create side effects, as in connectRepo.
    const created = await runGuarded({
      permission: { action: "create", resource: "database" },
      run: async () => {
        let project = await db.query.projects.findFirst({
          where: eq(projects.name, data.projectName),
        });
        if (!project) {
          const [created] = await db
            .insert(projects)
            .values({ name: data.projectName })
            .returning();
          if (!created) {
            throw new Error("could not create project");
          }
          project = created;
        }

        let environment = await db.query.environments.findFirst({
          where: and(
            eq(environments.projectId, project.id),
            eq(environments.name, data.environmentName)
          ),
        });
        if (!environment) {
          const [created] = await db
            .insert(environments)
            .values({ name: data.environmentName, projectId: project.id })
            .returning();
          if (!created) {
            throw new Error("could not create environment");
          }
          environment = created;
        }

        const password = data.rootPassword ?? generateDatabasePassword();
        const hasNamedDatabase = HAS_NAMED_DATABASE[data.engine];

        const [database] = await db
          .insert(databases)
          .values({
            databaseName: hasNamedDatabase
              ? (data.databaseName ?? defaultIdentifier(data.name))
              : null,
            description: data.description ?? null,
            engine: data.engine,
            environmentId: environment.id,
            image: data.image ?? DEFAULT_DATABASE_IMAGE[data.engine],
            name: data.name,
            rootPasswordEncrypted: "placeholder",
            rootUser: hasNamedDatabase
              ? (data.rootUser ?? DEFAULT_DATABASE_USER[data.engine])
              : null,
            serverId: data.serverId,
            swarmName: "placeholder",
          })
          .returning();
        if (!database) {
          throw new Error("could not create database");
        }

        await db
          .update(databases)
          .set({
            rootPasswordEncrypted: encryptSecret(
              password,
              env.appKey,
              secretContext.databasePassword(database.id)
            ),
            swarmName: newDatabaseSwarmName(database),
          })
          .where(eq(databases.id, database.id));

        await enqueueDeploy({
          databaseId: database.id,
          kind: "provision-database",
        });
        return { databaseId: database.id, name: database.name };
      },
      // Never the generated root password, which this handler also holds.
      target: ({ result }) => ({ id: result.databaseId, name: result.name }),
    });
    return { databaseId: created.databaseId };
  });
