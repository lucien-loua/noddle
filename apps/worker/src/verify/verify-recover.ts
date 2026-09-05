// tier: local
import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  servers,
  services,
  sshKeys,
} from "@noddle/db/schema";
import { check, cleanup, runVerify } from "@noddle/testing";
import { devStack } from "@noddle/testing/dev-stack";
import { eq } from "drizzle-orm";

import { recoverStaleDeployments } from "#deploy/recover";

await runVerify("stale deployments are resolved at boot", async () => {
  const db = createDatabase({ url: devStack().databaseUrl });
  const tag = crypto.randomUUID();
  const keyId = crypto.randomUUID();
  const serverId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  const serviceId = crypto.randomUUID();

  cleanup(async () => {
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(servers).where(eq(servers.id, serverId));
    await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  });

  await db.insert(sshKeys).values({
    id: keyId,
    name: `recover-${tag}`,
    privateKeyEncrypted: "unused",
  });
  await db.insert(servers).values({
    host: `recover-${tag}.invalid`,
    id: serverId,
    name: `recover-${tag}`,
    sshKeyId: keyId,
    sshUser: "verify",
  });
  await db.insert(projects).values({ id: projectId, name: `recover-${tag}` });
  await db.insert(environments).values({
    id: environmentId,
    isDefault: true,
    name: "production",
    projectId,
  });
  await db.insert(services).values({
    environmentId,
    id: serviceId,
    name: "svc",
    serverId,
    sourceType: "git",
    status: "deploying",
  });

  const [building] = await db
    .insert(deployments)
    .values({ serviceId, status: "building" })
    .returning();
  const [queued] = await db
    .insert(deployments)
    .values({ serviceId, status: "queued" })
    .returning();
  const [done] = await db
    .insert(deployments)
    .values({ serviceId, status: "succeeded" })
    .returning();

  if (!(building && queued && done)) {
    check("seeded deployments", false);
    return;
  }

  await recoverStaleDeployments({ db } as Parameters<
    typeof recoverStaleDeployments
  >[0]);

  const [buildingRow, queuedRow, doneRow, serviceRow] = await Promise.all([
    db.query.deployments.findFirst({ where: eq(deployments.id, building.id) }),
    db.query.deployments.findFirst({ where: eq(deployments.id, queued.id) }),
    db.query.deployments.findFirst({ where: eq(deployments.id, done.id) }),
    db.query.services.findFirst({ where: eq(services.id, serviceId) }),
  ]);

  check(
    "a row left building is failed, not left hanging",
    buildingRow?.status === "failed"
  );
  check(
    "it says why, so the dashboard is not silent about it",
    buildingRow?.errorMessage?.includes("worker restarted") === true
  );
  check("it is given a finish time", buildingRow?.finishedAt !== null);

  check(
    "a QUEUED row is left alone — its job is still waiting in Redis",
    queuedRow?.status === "queued"
  );
  check(
    "a finished row is not touched",
    doneRow?.status === "succeeded" && doneRow?.errorMessage === null
  );

  check(
    "the service stops reading deploying",
    serviceRow?.status !== "deploying",
    serviceRow?.status
  );
  check(
    "and carries the reason",
    serviceRow?.lastError?.includes("worker restarted") === true
  );
});
