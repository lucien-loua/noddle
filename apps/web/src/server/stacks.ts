import {
  environments,
  projects,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { markDeleting } from "@noddle/shared/lifecycle";
import { newStackSwarmName } from "@noddle/shared/swarm-names";
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
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";
import type { DeploymentSummary } from "@/server/dashboard";

export const connectStack = createServerFn({ method: "POST" })
  .validator(connectStackSchema)
  .handler(async ({ data }): Promise<{ stackId: string }> => {
    // The Stack is the object; the Project and Environment this may also
    // have created are find-or-create side effects.
    const guarded = await runGuarded({
      permission: { action: "create", resource: "service" },
      run: async () => {
        // Find-or-create by name, exactly like `connectRepo`: the same
        // project/environment holds several services AND several stacks.
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

        // The Swarm namespace carries 8 hex characters drawn from the
        // identifier, so it can only be written once the row is created — same
        // constraint as a database's password, bound by AAD. Without it, two
        // `web` stacks living in two environments would share services, network
        // and VOLUMES.
        await db
          .update(stacks)
          .set({ swarmName: newStackSwarmName(stack) })
          .where(eq(stacks.id, stack.id));

        return { name: stack.name, stackId: stack.id };
      },
      target: ({ result }) => ({ id: result.stackId, name: result.name }),
    });
    return { stackId: guarded.stackId };
  });

export const triggerStackDeploy = createServerFn({ method: "POST" })
  .validator(stackDeployRequestSchema)
  .handler(async ({ data }): Promise<{ stackDeploymentId: string }> =>
    runGuarded({
      load: () =>
        db.query.stacks.findFirst({ where: eq(stacks.id, data.stackId) }),
      notFoundMessage: "stack not found",
      permission: { action: "deploy", resource: "service" },
      // Same path as the webhook, which queues the same row without a
      // session.
      run: ({ row }) => queueStackDeploy(row.id, { trigger: "manual" }),
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const triggerStackRollback = createServerFn({ method: "POST" })
  .validator(stackRollbackRequestSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    // The audit object is the Stack, not the deployment the caller named.
    runGuarded({
      load: () =>
        db.query.stacks.findFirst({ where: eq(stacks.id, data.stackId) }),
      notFoundMessage: "stack not found",
      permission: { action: "rollback", resource: "service" },
      run: async () => {
        // Re-read from the database rather than trusted as given: the client
        // sends a deployment id, not a compose text — same reason as
        // `triggerRollback` for the single-service path.
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
            "this deployment produced nothing — there is nothing to redeploy"
          );
        }

        await enqueueDeploy({
          kind: "rollback-stack",
          sourceDeploymentId: data.sourceDeploymentId,
          stackId: data.stackId,
        });
        return { ok: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
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
    // Registry retention doesn't touch stacks: they stay pinned to their
    // server, and their replay starts from the saved compose TEXT, not from
    // a retained image.
    imagePurged: false,
    // `DeploymentHistory` only uses this to decide whether a "Redeploy"
    // makes sense: a stack qualifies as soon as a compose text has been
    // saved, whether it built an image or just pointed to `image:`.
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

/**
 * Delete a stack.
 *
 * `deleting` covers the interval during which the containers still exist
 * but the stack is condemned — same state and same reason as for a
 * service: the screen must tell the truth while Swarm is working.
 *
 * On the SAME queue as deployments: without that, a deletion and a
 * deployment of the same stack would race, and the latter would recreate
 * what the former just removed.
 */
export const deleteStack = createServerFn({ method: "POST" })
  .validator(deleteStackSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      // Re-checked by the helper: a dialog box only protects the clients
      // that display it.
      confirmName: { expected: (row) => row.name, typed: data.confirmName },
      load: () =>
        db.query.stacks.findFirst({ where: eq(stacks.id, data.stackId) }),
      notFoundMessage: "stack not found",
      permission: { action: "delete", resource: "service" },
      run: async ({ row: stack }) => {
        await db
          .update(stacks)
          .set(markDeleting(null))
          .where(eq(stacks.id, stack.id));
        await enqueueDeploy({ kind: "delete-stack", stackId: stack.id });
        return { ok: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
