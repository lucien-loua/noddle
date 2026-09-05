import {
  environments,
  projects,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { markDeleting } from "@noddle/shared/lifecycle";
import { newStackSwarmName } from "@noddle/shared/swarm-names";
import { renameStackSchema } from "@noddle/shared/validation/service";
import {
  connectStackSchema,
  deleteStackSchema,
  stackDeployRequestSchema,
  stackRollbackRequestSchema,
} from "@noddle/shared/validation/stack";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueStackDeploy } from "@/lib/deploy-queue.server";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";
import type { DeploymentSummary } from "@/server/dashboard";

export const connectStack = createServerFn({ method: "POST" })
  .validator(connectStackSchema)
  .handler(async ({ data }): Promise<{ stackId: string }> => {
    const outcome = await runGuarded({
      permission: { action: "create", resource: "service" },
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
          environment = await insertProjectEnvironment({
            name: data.environmentName,
            projectId: project.id,
          });
        }

        const [stack] = await db
          .insert(stacks)
          .values({
            composeFilePath: data.composeFilePath,
            domain: data.domain,
            environmentId: environment.id,
            gitBranch: data.gitBranch,
            gitRepoUrl: data.gitRepoUrl,
            name: data.name,
            port: data.port,
            publicService: data.publicService,
            serverId: data.serverId,
            swarmName: "placeholder",
          })
          .returning();
        if (!stack) {
          throw new Error("could not create stack");
        }

        await db
          .update(stacks)
          .set({ swarmName: newStackSwarmName(stack) })
          .where(eq(stacks.id, stack.id));

        return { name: stack.name, stackId: stack.id };
      },
      target: ({ result }) => ({ id: result.stackId, name: result.name }),
    });
    return { stackId: outcome.stackId };
  });

export const triggerStackDeploy = createServerFn({ method: "POST" })
  .validator(stackDeployRequestSchema)
  .handler(async ({ data }): Promise<{ stackDeploymentId: string }> =>
    runGuarded({
      ...guarded.stack(data.stackId),
      permission: { action: "deploy", resource: "service" },
      run: ({ row }) => queueStackDeploy(row.id, { trigger: "manual" }),
      target: identityTarget,
    })
  );

export const triggerStackRollback = createServerFn({ method: "POST" })
  .validator(stackRollbackRequestSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.stack(data.stackId),
      permission: { action: "rollback", resource: "service" },
      run: async () => {
        const target = await db.query.stackDeployments.findFirst({
          where: and(
            eq(stackDeployments.id, data.sourceDeploymentId),
            eq(stackDeployments.stackId, data.stackId)
          ),
        });
        if (!target) {
          throw new Error("deployment not found for this stack");
        }
        if (!target.composeSource) {
          throw new Error(
            "this deployment produced nothing, so there is nothing to redeploy"
          );
        }

        await enqueueDeploy({
          kind: "rollback-stack",
          sourceDeploymentId: data.sourceDeploymentId,
          stackId: data.stackId,
        });
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

function toSummary(
  row: typeof stackDeployments.$inferSelect
): DeploymentSummary {
  return {
    commitSha: row.commitSha,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    imagePurged: false,
    imageTag: row.composeSource ? row.id : null,
    nodeName: null,
    status: row.status,
    trigger: row.trigger,
  };
}

export const getStackDeployments = createServerFn({ method: "GET" })
  .validator((data: { stackId: string }) => data)
  .handler(async ({ data }): Promise<DeploymentSummary[]> => {
    await requireSession();
    const rows = await db.query.stackDeployments.findMany({
      limit: 50,
      orderBy: desc(stackDeployments.createdAt),
      where: eq(stackDeployments.stackId, data.stackId),
    });
    return rows.map(toSummary);
  });

export const renameStack = createServerFn({ method: "POST" })
  .validator(renameStackSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.stack(data.stackId),
      permission: { action: "create", resource: "service" },
      run: async ({ row: stack }) => {
        await db
          .update(stacks)
          .set({ displayName: data.displayName || null })
          .where(eq(stacks.id, stack.id));
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

export const deleteStack = createServerFn({ method: "POST" })
  .validator(deleteStackSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      confirmName: { expected: (row) => row.name, typed: data.confirmName },
      ...guarded.stack(data.stackId),
      permission: { action: "delete", resource: "service" },
      run: async ({ row: stack }) => {
        await db
          .update(stacks)
          .set(markDeleting(null))
          .where(eq(stacks.id, stack.id));
        await enqueueDeploy({ kind: "delete-stack", stackId: stack.id });
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );
