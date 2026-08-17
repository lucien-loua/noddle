import { encryptSecret, secretContext } from "@noddle/crypto";
import {
  DEFAULT_DATABASE_IMAGE,
  DEFAULT_DATABASE_USER,
  HAS_NAMED_DATABASE,
} from "@noddle/database-spec";
import { databases, environments, projects } from "@noddle/db/schema";
import { generateDatabasePassword } from "@noddle/shared/password";
import { newDatabaseSwarmName } from "@noddle/shared/swarm-names";
import { connectDatabaseSchema } from "@noddle/shared/validation/database";
import type { ConnectDatabaseInput } from "@noddle/shared/validation/database";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueDatabaseProvision } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { runGuarded } from "@/lib/permission.server";

const NON_IDENTIFIER = /[^a-z0-9_]/g;
const STARTS_LEGALLY = /^[a-z_]/;

function defaultIdentifier(serviceName: string): string {
  const folded = serviceName.toLowerCase().replace(NON_IDENTIFIER, "_");
  return STARTS_LEGALLY.test(folded) ? folded : `db_${folded}`;
}

/**
 * Creates the Project, Environment and Database rows for a connect request.
 *
 * Hoisted out of the handler so the guard's closure does not push an
 * already-dense body past the complexity ceiling.
 */
async function createDatabaseRows(
  data: ConnectDatabaseInput,
): Promise<{ databaseId: string; name: string }> {
  let project = await db.query.projects.findFirst({
    where: eq(projects.name, data.projectName),
  });
  if (!project) {
    const [created] = await db.insert(projects).values({ name: data.projectName }).returning();
    if (!created) {
      throw new Error("could not create project");
    }
    project = created;
  }

  let environment = await db.query.environments.findFirst({
    where: and(eq(environments.projectId, project.id), eq(environments.name, data.environmentName)),
  });
  if (!environment) {
    environment = await insertProjectEnvironment({
      name: data.environmentName,
      projectId: project.id,
    });
  }

  const password = data.rootPassword ?? generateDatabasePassword();
  const hasNamedDatabase = HAS_NAMED_DATABASE[data.engine];

  const [database] = await db
    .insert(databases)
    .values({
      databaseName: hasNamedDatabase ? (data.databaseName ?? defaultIdentifier(data.name)) : null,
      description: data.description ?? null,
      engine: data.engine,
      environmentId: environment.id,
      image: data.image ?? DEFAULT_DATABASE_IMAGE[data.engine],
      name: data.name,
      rootPasswordEncrypted: "placeholder",
      rootUser: hasNamedDatabase ? (data.rootUser ?? DEFAULT_DATABASE_USER[data.engine]) : null,
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
        secretContext.databasePassword(database.id),
      ),
      swarmName: newDatabaseSwarmName(database),
    })
    .where(eq(databases.id, database.id));

  // Provision is queued at create, not left for a later Deploy click:
  // a database is an image, not a build. `queueDatabaseProvision` also
  // writes `deploying` so the project page doesn't flash "Never deployed".
  await queueDatabaseProvision(database.id);
  return { databaseId: database.id, name: database.name };
}

export const connectDatabase = createServerFn({ method: "POST" })
  .validator(connectDatabaseSchema)
  .handler(async ({ data }): Promise<{ databaseId: string }> => {
    // The Database is the object; the Project and Environment are
    // find-or-create side effects, as in connectRepo.
    const guarded = await runGuarded({
      permission: { action: "create", resource: "database" },
      run: () => createDatabaseRows(data),
      // Never the generated root password, which this handler also holds.
      target: ({ result }) => ({ id: result.databaseId, name: result.name }),
    });
    return { databaseId: guarded.databaseId };
  });
