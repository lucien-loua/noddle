// tier: local
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  databases,
  environments,
  envVars,
  projects,
  servers,
  serviceDependencies,
  services,
  sshKeys,
} from "@noddle/db/schema";
import { check, cleanup, expectThrowsAsync, runVerify } from "@noddle/testing";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";

const WEB_SRC = import.meta.dirname;

/** Shared by every local suite, so the slate is cleared both ways. */
const wipe = async () => {
  await db.delete(serviceDependencies);
  await db.delete(envVars);
  await db.delete(databases);
  await db.delete(services);
  await db.delete(environments);
  await db.delete(projects);
  await db.delete(servers);
};

const edgeCount = async () =>
  (await db.select().from(serviceDependencies)).length;

await wipe();
cleanup(wipe);

await runVerify("service dependencies (the topology edge)", async () => {
  const [sshKey] = await db
    .insert(sshKeys)
    .values({ name: "deps-probe", privateKeyEncrypted: "placeholder" })
    .onConflictDoUpdate({
      set: { privateKeyEncrypted: "placeholder" },
      target: sshKeys.name,
    })
    .returning();
  const [server] = await db
    .insert(servers)
    .values({
      host: "192.0.2.20",
      name: "deps-probe",
      role: "manager",
      sshKeyId: sshKey?.id ?? "",
      sshUser: "ubuntu",
      status: "connected",
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ name: "deps-proj" })
    .returning();
  const [environment] = await db
    .insert(environments)
    .values({ name: "production", projectId: project?.id ?? "" })
    .returning();

  const makeService = async (name: string) =>
    (
      await db
        .insert(services)
        .values({
          environmentId: environment?.id ?? "",
          gitBranch: "main",
          gitRepoUrl: `https://example.invalid/${name}.git`,
          name,
          port: 3000,
          serverId: server?.id ?? "",
          sourceType: "git",
        })
        .returning()
    )[0];

  const api = await makeService("api");
  const worker = await makeService("worker");
  const [database] = await db
    .insert(databases)
    .values({
      engine: "postgres",
      environmentId: environment?.id ?? "",
      name: "main-db",
      rootPasswordEncrypted: "placeholder",
      serverId: server?.id ?? "",
      swarmName: "deps-probe-db",
    })
    .returning();

  const apiId = api?.id ?? "";
  const workerId = worker?.id ?? "";
  const databaseId = database?.id ?? "";

  await db
    .insert(serviceDependencies)
    .values({ dependsOnDatabaseId: databaseId, serviceId: apiId });
  check("a service can declare the database it consumes", true);

  await db
    .insert(serviceDependencies)
    .values({ dependsOnServiceId: workerId, serviceId: apiId });
  check("a service can declare another service", true);

  await expectThrowsAsync("the same pair cannot be declared twice", () =>
    db
      .insert(serviceDependencies)
      .values({ dependsOnDatabaseId: databaseId, serviceId: apiId })
  );

  await expectThrowsAsync("an edge with no target is refused", () =>
    db.insert(serviceDependencies).values({ serviceId: apiId })
  );

  await expectThrowsAsync("an edge with two targets is refused", () =>
    db.insert(serviceDependencies).values({
      dependsOnDatabaseId: databaseId,
      dependsOnServiceId: workerId,
      serviceId: apiId,
    })
  );

  await expectThrowsAsync("a service cannot depend on itself", () =>
    db
      .insert(serviceDependencies)
      .values({ dependsOnServiceId: apiId, serviceId: apiId })
  );

  // A cycle is not the database's job to refuse: the edge is declarative and
  // orders nothing. If it ever orders deploys, that check goes in the worker.
  await db
    .insert(serviceDependencies)
    .values({ dependsOnServiceId: apiId, serviceId: workerId });
  check("the reverse edge is accepted — cycles are not refused here", true);

  check("three edges stand", (await edgeCount()) === 3);

  await db.delete(databases).where(eq(databases.id, databaseId));
  check(
    "deleting the database takes its edge with it",
    (await edgeCount()) === 2
  );

  await db.delete(services).where(eq(services.id, workerId));
  check(
    "deleting a service takes the edges on BOTH of its ends",
    (await edgeCount()) === 0
  );

  // The edge is only true if something writes it. Attaching is the one moment
  // the link is known — the connection string is encrypted right after.
  const attach = readFileSync(
    join(WEB_SRC, "server/databases/attach.ts"),
    "utf-8"
  );
  check(
    "attachDatabase records the edge",
    attach.includes("insert(serviceDependencies)") &&
      attach.includes("onConflictDoNothing()")
  );
});
