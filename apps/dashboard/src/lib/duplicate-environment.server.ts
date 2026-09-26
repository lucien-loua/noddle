import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { envVars, services, stacks } from "@noddle/db/schema";
import { buildSpecOf } from "@noddle/shared/build-spec";
import { newStackSwarmName } from "@noddle/shared/swarm-names";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { insertProjectEnvironment } from "@/lib/environment.server";
import type { environmentForDuplicate } from "@/lib/team-queries.server";
import { environmentNameTaken } from "@/lib/team-queries.server";

export type DuplicateSource = NonNullable<
  Awaited<ReturnType<typeof environmentForDuplicate>>
>;

export async function copyEnvironment(
  source: DuplicateSource,
  data: { name: string },
  teamId: string
): Promise<{
  databasesSkipped: number;
  environmentId: string;
  environmentName: string;
  servicesCopied: number;
  stacksCopied: number;
}> {
  if (await environmentNameTaken(db, teamId, source.projectId, data.name)) {
    throw new Error(`"${data.name}" already exists in this project`);
  }

  const target = await insertProjectEnvironment({
    description: source.description,
    name: data.name,
    projectId: source.projectId,
  });

  for (const s of source.services) {
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
