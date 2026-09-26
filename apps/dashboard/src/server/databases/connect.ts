import { encryptSecret, secretContext } from "@noddle/crypto";
import { databases } from "@noddle/db/schema";
import {
  DEFAULT_DATABASE_IMAGE,
  DEFAULT_DATABASE_USER,
  HAS_NAMED_DATABASE,
} from "@noddle/shared/database-spec";
import { generateDatabasePassword } from "@noddle/shared/password";
import { newDatabaseSwarmName } from "@noddle/shared/swarm-names";
import { connectDatabaseSchema } from "@noddle/shared/validation/database";
import type { ConnectDatabaseInput } from "@noddle/shared/validation/database";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueDatabaseProvision } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { runGuarded } from "@/lib/permission.server";
import {
  environmentByName,
  findOrCreateTeamProject,
} from "@/lib/team-queries.server";
import { activeTeamId } from "@/lib/team-scope.server";

const NON_IDENTIFIER = /[^a-z0-9_]/g;
const STARTS_LEGALLY = /^[a-z_]/;

function defaultIdentifier(serviceName: string): string {
  const folded = serviceName.toLowerCase().replace(NON_IDENTIFIER, "_");
  return STARTS_LEGALLY.test(folded) ? folded : `db_${folded}`;
}

async function createDatabaseRows(
  data: ConnectDatabaseInput,
  teamId: string
): Promise<{
  databaseId: string;
  deploymentId: string;
  environmentId: string;
  name: string;
  projectId: string;
}> {
  const project = await findOrCreateTeamProject(db, teamId, data.projectName);
  const environment =
    (await environmentByName(db, teamId, project.id, data.environmentName)) ??
    (await insertProjectEnvironment({
      name: data.environmentName,
      projectId: project.id,
    }));

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

  const { deploymentId } = await queueDatabaseProvision(database.id);
  return {
    databaseId: database.id,
    deploymentId,
    environmentId: database.environmentId,
    name: database.name,
    projectId: project.id,
  };
}

export const connectDatabase = createServerFn({ method: "POST" })
  .validator(connectDatabaseSchema)
  .handler(
    async ({
      data,
    }): Promise<{
      databaseId: string;
      deploymentId: string;
      environmentId: string;
      name: string;
      projectId: string;
    }> => {
      const guarded = await runGuarded({
        permission: { action: "create", resource: "database" },
        run: async () => createDatabaseRows(data, await activeTeamId()),
        target: ({ result }) => ({ id: result.databaseId, name: result.name }),
      });
      return {
        databaseId: guarded.databaseId,
        deploymentId: guarded.deploymentId,
        environmentId: guarded.environmentId,
        name: guarded.name,
        projectId: guarded.projectId,
      };
    }
  );
