// tier: local
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  databases,
  envVars,
  environments,
  projects,
  servers,
  serviceDependencies,
  services,
  sshKeys,
} from "@noddle/db/schema";
import { check, cleanup, expectThrowsAsync, runVerify } from "@noddle/testing";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db.server";

const WEB_SRC = import.meta.dirname;

const PROJECT = "deps-proj";
const PROBE = "deps-probe";

/**
 * Removes THIS suite's rows, by name — never `delete(table)`.
 *
 * The other local suites clear the shared tables wholesale, and that cost a
 * real project twice in one session: the bench is run against the same
 * database a person is using. Deleting the project cascades to its
 * environments, services, databases and dependencies, so three statements
 * are enough, and nothing else on the machine is touched.
 */
const wipe = async () => {
  await db.delete(projects).where(eq(projects.name, PROJECT));
  await db.delete(servers).where(eq(servers.name, PROBE));
  await db.delete(sshKeys).where(eq(sshKeys.name, PROBE));
};

/**
 * The suite's OWN edges, never `count(*)`.
 *
 * A global count read correctly only because the bench used to empty the
 * table first. Now that it leaves other people's rows alone, counting all of
 * them makes the result depend on what else lives in the database.
 */
const edgeCount = async (serviceIds: string[]) =>
  (
    await db
      .select()
      .from(serviceDependencies)
      .where(inArray(serviceDependencies.serviceId, serviceIds))
  ).length;

await wipe();
cleanup(wipe);

await runVerify("service dependencies (the topology edge)", async () => {
  const [sshKey] = await db
    .insert(sshKeys)
    .values({ name: PROBE, privateKeyEncrypted: "placeholder" })
    .returning();
  const [server] = await db
    .insert(servers)
    .values({
      host: "192.0.2.20",
      name: PROBE,
      role: "manager",
      sshKeyId: sshKey?.id ?? "",
      sshUser: "ubuntu",
      status: "connected",
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ name: PROJECT })
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
  const mine = [apiId, workerId];
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

  check("three edges stand", (await edgeCount(mine)) === 3);

  await db.delete(databases).where(eq(databases.id, databaseId));
  check(
    "deleting the database takes its edge with it",
    (await edgeCount(mine)) === 2
  );

  await db.delete(services).where(eq(services.id, workerId));
  check(
    "deleting a service takes the edges on BOTH of its ends",
    (await edgeCount(mine)) === 0
  );

  // A fresh database: the first one was deleted above, to prove the cascade.
  const [second] = await db
    .insert(databases)
    .values({
      engine: "postgres",
      environmentId: environment?.id ?? "",
      name: "second-db",
      rootPasswordEncrypted: "placeholder",
      serverId: server?.id ?? "",
      swarmName: "deps-probe-second",
    })
    .returning();
  const secondDatabaseId = second?.id ?? "";

  // The ADR's rule, at the level that enforces it: deleting the variable by
  // hand does not undo the statement. The edge stays and merely forgets which
  // variable carried it — which is what lets the screen say "variable
  // removed" instead of inventing a key.
  const [variable] = await db
    .insert(envVars)
    .values({
      isSecret: true,
      key: "DATABASE_URL",
      serviceId: apiId,
      valueEncrypted: "placeholder",
    })
    .returning();
  const [linked] = await db
    .insert(serviceDependencies)
    .values({
      dependsOnDatabaseId: secondDatabaseId,
      envVarId: variable?.id,
      serviceId: apiId,
    })
    .returning();
  await db.delete(envVars).where(eq(envVars.id, variable?.id ?? ""));
  const survivor = await db.query.serviceDependencies.findFirst({
    where: eq(serviceDependencies.id, linked?.id ?? ""),
  });
  check(
    "deleting the variable leaves the edge, with no variable",
    survivor !== undefined && survivor.envVarId === null
  );

  // The edge is only true if something writes it. Attaching is the one moment
  // the link is known — the connection string is encrypted right after.
  const attach = readFileSync(
    join(WEB_SRC, "server/databases/attach.ts"),
    "utf-8"
  );
  check(
    "attachDatabase records the edge AND the variable it wrote",
    attach.includes("insert(serviceDependencies)") &&
      attach.includes("envVarId,") &&
      attach.includes("onConflictDoUpdate(")
  );

  const detach = readFileSync(join(WEB_SRC, "server/dependencies.ts"), "utf-8");
  check(
    "detachDatabase removes the edge AND its variable",
    detach.includes("delete(serviceDependencies)") &&
      detach.includes("delete(envVars)")
  );
});
