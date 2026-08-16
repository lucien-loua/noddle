import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { environments, envVars, services, stacks } from "@noddle/db/schema";
import { buildSpecOf } from "@noddle/shared/build-spec";
import { newStackSwarmName } from "@noddle/shared/swarm-names";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { insertProjectEnvironment } from "@/lib/environment.server";

/**
 * Copies an Environment's services, stacks and variables into a new one.
 *
 * Hoisted out of the handler: wrapping an already-dense body in the guard's
 * closure pushed it past the complexity ceiling.
 */
export type DuplicateSource = NonNullable<
  Awaited<ReturnType<typeof loadEnvironmentForDuplicate>>
>;

export function loadEnvironmentForDuplicate(environmentId: string) {
  return db.query.environments.findFirst({
    where: eq(environments.id, environmentId),
    with: {
      databases: true,
      services: { with: { envVars: true } },
      stacks: true,
    },
  });
}

export async function copyEnvironment(
  source: DuplicateSource,
  data: { name: string }
): Promise<{
  databasesSkipped: number;
  environmentId: string;
  environmentName: string;
  servicesCopied: number;
  stacksCopied: number;
}> {
  const nameTaken = await db.query.environments.findFirst({
    where: and(
      eq(environments.projectId, source.projectId),
      eq(environments.name, data.name)
    ),
  });
  if (nameTaken) {
    throw new Error(`"${data.name}" already exists in this project`);
  }

  const target = await insertProjectEnvironment({
    description: source.description,
    name: data.name,
    projectId: source.projectId,
  });

  for (const s of source.services) {
    // biome-ignore lint/performance/noAwaitInLoops: each copied service must exist before we can encrypt its variables under ITS id
    const [clone] = await db
      .insert(services)
      .values({
        ...buildSpecOf(s),
        environmentId: target.id,
        name: s.name,
        serverId: s.serverId,
      })
      .returning();
    if (!clone) {
      throw new Error(`could not copy service "${s.name}"`);
    }

    for (const v of s.envVars) {
      const value = decryptSecret(
        v.valueEncrypted,
        env.appKey,
        secretContext.envVar(v.id)
      );
      // biome-ignore lint/performance/noAwaitInLoops: ordered writes, the AAD binds each secret to the row that was just created
      const [row] = await db
        .insert(envVars)
        .values({
          isSecret: v.isSecret,
          key: v.key,
          serviceId: clone.id,
          valueEncrypted: "placeholder",
        })
        .returning();
      if (!row) {
        throw new Error("could not copy an environment variable");
      }
      await db
        .update(envVars)
        .set({
          valueEncrypted: encryptSecret(
            value,
            env.appKey,
            secretContext.envVar(row.id)
          ),
        })
        .where(eq(envVars.id, row.id));
    }
  }

  for (const st of source.stacks) {
    // biome-ignore lint/performance/noAwaitInLoops: the Swarm name is computed from the id, which only exists once the row is created
    const [clone] = await db
      .insert(stacks)
      .values({
        composeFilePath: st.composeFilePath,
        domain: null,
        environmentId: target.id,
        gitBranch: st.gitBranch,
        gitRepoUrl: st.gitRepoUrl,
        name: st.name,
        port: st.port,
        publicService: st.publicService,
        serverId: st.serverId,
        swarmName: "placeholder",
      })
      .returning();
    if (!clone) {
      throw new Error(`could not copy stack "${st.name}"`);
    }
    await db
      .update(stacks)
      .set({ swarmName: newStackSwarmName(clone) })
      .where(eq(stacks.id, clone.id));
  }

  return {
    databasesSkipped: source.databases.length,
    environmentId: target.id,
    environmentName: target.name,
    servicesCopied: source.services.length,
    stacksCopied: source.stacks.length,
  };
}
