import {
  databases,
  environments,
  envVars,
  projects,
  services,
  stacks,
} from "@noddle/db/schema";
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/crypto";
import { newStackSwarmName } from "@noddle/shared/swarm-names";
import {
  createEnvironmentSchema,
  duplicateEnvironmentSchema,
  environmentIdSchema,
  renameEnvironmentSchema,
} from "@noddle/shared/validation/project";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface EnvironmentView {
  description: string | null;
  id: string;
  name: string;
}

/**
 * ALL of a project's environments, even those without a single resource.
 *
 * Distinct from `getDashboardGroups`: there, a `Scope` only exists as a side
 * effect of connecting a resource — true since Phase 1, and it stays that
 * way for `/`, `/deployments` and the sidebar, which have no reason to
 * change. But `createEnvironment` is the FIRST way to make an environment
 * exist without connecting anything to it at the same time: without this
 * separate read, a freshly created and still-empty environment would show
 * up nowhere, including in the selector whose whole purpose is to deploy
 * its first resource there.
 */
export const getProjectEnvironments = createServerFn({ method: "GET" })
  .validator((data: { projectId: string }) => data)
  .handler(async ({ data }): Promise<EnvironmentView[]> => {
    await requireSession();
    const rows = await db.query.environments.findMany({
      orderBy: environments.name,
      where: eq(environments.projectId, data.projectId),
    });
    return rows.map((e) => ({
      description: e.description,
      id: e.id,
      name: e.name,
    }));
  });

export const createEnvironment = createServerFn({ method: "POST" })
  .validator(createEnvironmentSchema)
  .handler(async ({ data }): Promise<{ environmentId: string }> => {
    const guarded = await runGuarded({
      // Loads the parent Project — it must exist — but the object recorded
      // is the Environment that comes out of `run`.
      load: () =>
        db.query.projects.findFirst({ where: eq(projects.id, data.projectId) }),
      notFoundMessage: "project not found",
      permission: { action: "create", resource: "service" },
      run: async () => {
        const existing = await db.query.environments.findFirst({
          where: and(
            eq(environments.projectId, data.projectId),
            eq(environments.name, data.name)
          ),
        });
        if (existing) {
          throw new Error(`"${data.name}" already exists in this project`);
        }

        const [created] = await db
          .insert(environments)
          .values({
            description: data.description,
            name: data.name,
            projectId: data.projectId,
          })
          .returning();
        if (!created) {
          throw new Error("could not create environment");
        }
        return { environmentId: created.id, name: created.name };
      },
      target: ({ result }) => ({ id: result.environmentId, name: result.name }),
    });
    return { environmentId: guarded.environmentId };
  });

export const renameEnvironment = createServerFn({ method: "POST" })
  .validator(renameEnvironmentSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.environments.findFirst({
            where: eq(environments.id, data.environmentId),
          }),
        notFoundMessage: "environment not found",
        permission: { action: "create", resource: "service" },
        run: async ({ row: environment }) => {
          const existing = await db.query.environments.findFirst({
            where: and(
              eq(environments.projectId, environment.projectId),
              eq(environments.name, data.name),
              ne(environments.id, environment.id)
            ),
          });
          if (existing) {
            throw new Error(`"${data.name}" already exists in this project`);
          }

          await db
            .update(environments)
            .set({ description: data.description, name: data.name })
            .where(eq(environments.id, environment.id));
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );

/**
 * Delete an environment — refused if it carries the slightest resource.
 *
 * The same kind of guard as elsewhere (`haveServices`), adapted: Noddle has
 * no `isDefault` environment to protect, but an environment that contains a
 * service, a stack or a database has real infrastructure behind it.
 * Deleting it here would tear everything down without the user having asked
 * for it — that path goes through the dedicated delete buttons, with THEIR
 * own confirmation. An empty environment, on the other hand, is just a row:
 * no job, no name confirmation.
 */
export const deleteEnvironment = createServerFn({ method: "POST" })
  .validator(environmentIdSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.environments.findFirst({
            where: eq(environments.id, data.environmentId),
          }),
        notFoundMessage: "environment not found",
        permission: { action: "delete", resource: "service" },
        run: async ({ row: environment }) => {
          const [service, stack, database] = await Promise.all([
            db.query.services.findFirst({
              where: eq(services.environmentId, environment.id),
            }),
            db.query.stacks.findFirst({
              where: eq(stacks.environmentId, environment.id),
            }),
            db.query.databases.findFirst({
              where: eq(databases.environmentId, environment.id),
            }),
          ]);
          if (service || stack || database) {
            throw new Error(
              "this environment still has services, stacks or databases — remove them first"
            );
          }

          await db
            .delete(environments)
            .where(eq(environments.id, environment.id));
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );

/**
 * Duplicate an environment — clones the CONFIGURATION, never the data.
 *
 * Services and stacks are copied config-only: new `id`, status reset to
 * `created`, no current deployment, no domain (the source domain stays with
 * its resource — duplicating it would put two services on the same Traefik
 * route), and an unconfigured webhook (a secret makes no sense once copied,
 * it would become readable again by whoever saw the original). A service's
 * environment variables ARE copied, secrets included — the same decision
 * as PR previews: a clone without `DATABASE_URL` doesn't start.
 *
 * DATABASES are explicitly excluded, and that's the whole point of this
 * change: a database has real data on a real volume. A "config-only" clone
 * would produce an empty database presenting itself as a copy — exactly
 * the misconception this file avoids elsewhere (backups, metrics).
 * `databasesSkipped` reports the count so the screen can say it, instead of
 * hiding it.
 */
/**
 * Copies an Environment's services, stacks and variables into a new one.
 *
 * Hoisted out of the handler: wrapping an already-dense body in the guard's
 * closure pushed it past the complexity ceiling.
 */
type DuplicateSource = NonNullable<
  Awaited<ReturnType<typeof loadEnvironmentForDuplicate>>
>;

function loadEnvironmentForDuplicate(environmentId: string) {
  return db.query.environments.findFirst({
    where: eq(environments.id, environmentId),
    with: {
      databases: true,
      services: { with: { envVars: true } },
      stacks: true,
    },
  });
}

async function copyEnvironment(
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

  const [target] = await db
    .insert(environments)
    .values({
      description: source.description,
      name: data.name,
      projectId: source.projectId,
    })
    .returning();
  if (!target) {
    throw new Error("could not create environment");
  }

  for (const s of source.services) {
    // biome-ignore lint/performance/noAwaitInLoops: each copied service must exist before we can encrypt its variables under ITS id
    const [clone] = await db
      .insert(services)
      .values({
        buildMethod: s.buildMethod,
        environmentId: target.id,
        gitBranch: s.gitBranch,
        gitRepoUrl: s.gitRepoUrl,
        name: s.name,
        port: s.port,
        registryId: s.registryId,
        serverId: s.serverId,
        sourceType: s.sourceType,
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

export const duplicateEnvironment = createServerFn({ method: "POST" })
  .validator(duplicateEnvironmentSchema)
  .handler(
    async ({
      data,
    }): Promise<{
      databasesSkipped: number;
      environmentId: string;
      servicesCopied: number;
      stacksCopied: number;
    }> =>
      runGuarded({
        load: () => loadEnvironmentForDuplicate(data.environmentId),
        notFoundMessage: "environment not found",
        permission: { action: "create", resource: "service" },
        run: ({ row: source }) => copyEnvironment(source, data),
        // The COPY is the object, not the source it was made from.
        target: ({ result }) => ({
          id: result.environmentId,
          name: result.environmentName,
        }),
      })
  );
