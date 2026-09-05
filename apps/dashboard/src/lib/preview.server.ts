import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import {
  environments,
  envVars,
  serviceDomains,
  services,
} from "@noddle/db/schema";
import { buildSpecOf } from "@noddle/shared/build-spec";
import { markDeleting } from "@noddle/shared/lifecycle";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const PREVIEW_LIMIT = 5;

const PREVIEW_ENVIRONMENT = "preview";

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
      envVars: true,
      environment: true,
    },
  });
  if (!parent) {
    return { ignored: "parent service not found" };
  }

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
    const { deploymentId } = await queueServiceDeploy(existing.id, {
      commitSha: opts.commitSha,
      trigger: "webhook",
    });
    return { created: false, deploymentId, serviceId: existing.id };
  }

  const live = await db.query.services.findMany({
    where: and(
      isNotNull(services.previewOfServiceId),
      ne(services.status, "deleting")
    ),
  });
  if (live.length >= PREVIEW_LIMIT) {
    return {
      ignored: `preview limit reached (${PREVIEW_LIMIT} live): close a pull request to free one`,
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
      ...buildSpecOf(parent),
      environmentId,
      gitBranch: opts.headBranch,
      name: previewServiceName(parent.name, opts.prNumber),
      prNumber: opts.prNumber,
      previewOfServiceId: parent.id,
      serverId: parent.serverId,
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
    return { ignored: "no preview for this pull request" };
  }

  await db
    .update(services)
    .set(markDeleting(null))
    .where(eq(services.id, preview.id));
  await enqueueDeploy({ kind: "delete-service", serviceId: preview.id });
  return { destroyed: preview.id };
}
