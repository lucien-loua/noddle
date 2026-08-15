import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import {
  environments,
  envVars,
  serviceDomains,
  services,
} from "@noddle/db/schema";
import { markDeleting } from "@noddle/shared/lifecycle";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { enqueueDeploy } from "@/lib/queue.server";

/**
 * How many previews can live at the same time, across the whole
 * installation.
 *
 * A constant, not a setting: the machine is what breaks, and a ceiling
 * you can raise isn't one. Measured on the VPS — a deployed application
 * weighs ~51 MiB, the control plane ~388 MiB; but a real Next.js
 * application climbs to 200-400 MiB, and the design target remains a
 * 2 GB machine. Five is what fits without starving the production
 * service sharing the same machine.
 */
export const PREVIEW_LIMIT = 5;

/** The environment where a project's previews live. */
const PREVIEW_ENVIRONMENT = "preview";

/**
 * `<parent>-pr-<n>`, truncated to fit in `serviceNameSchema` (48).
 *
 * The suffix is what must survive: two previews of the same parent are
 * only distinguished by it. So it's the PREFIX that gets cut.
 */
export function previewServiceName(
  parentName: string,
  prNumber: number
): string {
  const suffix = `-pr-${prNumber}`;
  return `${parentName.slice(0, 48 - suffix.length)}${suffix}`;
}

export type PreviewOutcome =
  | { created: boolean; deploymentId: string; serviceId: string }
  | { ignored: string };

/**
 * Creates the preview if it doesn't exist, then deploys it at the PR's
 * commit. A `synchronize` falls back onto the SAME row — the partial
 * unique index `(preview_of_service_id, pr_number)` enforces it, without
 * which every push to the branch would leave behind one more service.
 */
export async function ensurePreview(opts: {
  commitSha: string;
  headBranch: string;
  parentServiceId: string;
  prNumber: number;
}): Promise<PreviewOutcome> {
  const parent = await db.query.services.findFirst({
    where: eq(services.id, opts.parentServiceId),
    with: {
      domains: { orderBy: asc(serviceDomains.createdAt) },
      environment: true,
      envVars: true,
    },
  });
  if (!parent) {
    return { ignored: "parent service not found" };
  }

  // Without a domain on the parent, the preview would have no URL — and a
  // preview you can't open is useless. We say so rather than deploying
  // something unreachable.
  if (parent.domains.length === 0) {
    return {
      ignored:
        "the parent service has no domain, so a preview would have no URL",
    };
  }

  const existing = await db.query.services.findFirst({
    where: and(
      eq(services.previewOfServiceId, parent.id),
      eq(services.prNumber, opts.prNumber)
    ),
  });

  if (existing) {
    // A PR's branch doesn't move, but its commit does: we redeploy the
    // existing row at the new SHA.
    const { deploymentId } = await queueServiceDeploy(existing.id, {
      commitSha: opts.commitSha,
      trigger: "webhook",
    });
    return { created: false, deploymentId, serviceId: existing.id };
  }

  // The ceiling only counts LIVE previews: one currently being torn down
  // has already freed its spot.
  const live = await db.query.services.findMany({
    where: and(
      isNotNull(services.previewOfServiceId),
      ne(services.status, "deleting")
    ),
  });
  if (live.length >= PREVIEW_LIMIT) {
    return {
      ignored: `preview limit reached (${PREVIEW_LIMIT} live) — close a pull request to free one`,
    };
  }

  const environment = await previewEnvironment(parent.environment.projectId);
  const serviceId = await createPreview(parent, environment.id, opts);

  const { deploymentId } = await queueServiceDeploy(serviceId, {
    commitSha: opts.commitSha,
    trigger: "webhook",
  });
  return { created: true, deploymentId, serviceId };
}

/** Finds-or-creates the project's `preview` environment. */
async function previewEnvironment(projectId: string) {
  const found = await db.query.environments.findFirst({
    where: and(
      eq(environments.projectId, projectId),
      eq(environments.name, PREVIEW_ENVIRONMENT)
    ),
  });
  if (found) {
    return found;
  }
  const [created] = await db
    .insert(environments)
    .values({ name: PREVIEW_ENVIRONMENT, projectId })
    .returning();
  if (!created) {
    throw new Error("could not create the preview environment");
  }
  return created;
}

type ParentService = typeof services.$inferSelect & {
  domains: (typeof serviceDomains.$inferSelect)[];
  envVars: (typeof envVars.$inferSelect)[];
};

async function createPreview(
  parent: ParentService,
  environmentId: string,
  opts: { commitSha: string; headBranch: string; prNumber: number }
): Promise<string> {
  const [preview] = await db
    .insert(services)
    .values({
      buildMethod: parent.buildMethod,
      buildPath: parent.buildPath,
      cleanCache: parent.cleanCache,
      deployKeyId: parent.deployKeyId,
      dockerImage: parent.dockerImage,
      environmentId,
      gitBranch: opts.headBranch,
      gitRepoUrl: parent.gitRepoUrl,
      // A preview builds the same repository: without this, a parent with
      // submodules builds and its PR does not.
      gitSubmodules: parent.gitSubmodules,
      name: previewServiceName(parent.name, opts.prNumber),
      port: parent.port,
      previewOfServiceId: parent.id,
      prNumber: opts.prNumber,
      serverId: parent.serverId,
      sourceType: parent.sourceType,
    })
    .returning();
  if (!preview) {
    throw new Error("could not create the preview service");
  }

  const baseHost = parent.domains[0]?.host;
  if (baseHost) {
    await db.insert(serviceDomains).values({
      host: `pr-${opts.prNumber}.${baseHost}`,
      serviceId: preview.id,
    });
  }

  await copyEnvVars(parent, preview.id);
  return preview.id;
}

/**
 * The parent's variables, SECRETS INCLUDED.
 *
 * This is the "like Vercel" decision: a preview that fails to start for
 * lack of `DATABASE_URL` is useless. The safeguard isn't here but
 * upstream — no preview is ever created for a PR coming from a FORK,
 * which is the only case where the executed code isn't from trusted people.
 *
 * Copied rather than shared: each value is RE-encrypted under the
 * identifier of ITS new row, because the AAD binds the ciphertext to the
 * row. An intended consequence — a variable can be fixed on a preview
 * without touching production.
 */
async function copyEnvVars(
  parent: ParentService,
  previewServiceId: string
): Promise<void> {
  if (parent.envVars.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    for (const v of parent.envVars) {
      const value = decryptSecret(
        v.valueEncrypted,
        env.appKey,
        secretContext.envVar(v.id)
      );
      // Insert in TWO steps: the AAD needs the new row's identifier, which
      // doesn't exist before the insert. Same shape as the host adoption
      // for the SSH key.
      // biome-ignore lint/performance/noAwaitInLoops: ordered writes within a transaction
      const [row] = await tx
        .insert(envVars)
        .values({
          isSecret: v.isSecret,
          key: v.key,
          serviceId: previewServiceId,
          valueEncrypted: "placeholder",
        })
        .returning();
      if (!row) {
        throw new Error("could not copy an environment variable");
      }
      await tx
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
  });
}

/**
 * Tears down the preview of a closed PR.
 *
 * Exactly the same path as the dashboard's "Delete" button: mark
 * `deleting`, then drop the teardown onto the deployment queue. The Swarm
 * service must disappear BEFORE the row — see `teardown.ts`.
 */
export async function destroyPreview(opts: {
  parentServiceId: string;
  prNumber: number;
}): Promise<PreviewOutcome | { destroyed: string }> {
  const preview = await db.query.services.findFirst({
    where: and(
      eq(services.previewOfServiceId, opts.parentServiceId),
      eq(services.prNumber, opts.prNumber)
    ),
  });
  if (!preview) {
    // A closed PR with no preview — a fork, a PR opened before the
    // webhook existed, or a teardown that already happened. Nothing to
    // do, and above all not an error.
    return { ignored: "no preview for this pull request" };
  }

  await db
    .update(services)
    .set(markDeleting(null))
    .where(eq(services.id, preview.id));
  await enqueueDeploy({ kind: "delete-service", serviceId: preview.id });
  return { destroyed: preview.id };
}
