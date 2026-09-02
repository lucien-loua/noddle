// tier: vm
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { databases, environments, projects, servers } from "@noddle/db/schema";
import { removeService } from "@noddle/deploy-engine/ops";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
} from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { provisionDatabase, removeSecretIfExists } from "#database";
import { seedSshKey, verifyCtx, verifyBuild } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \u001B[32m✓\u001B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \u001B[31m✗\u001B[0m ${m}`);
};

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const { privateKey } = TARGET;
const sshKeyId = await seedSshKey(db, appKey, "verify-database", privateKey);

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [TARGET.host]));

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "database-probe-manager",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("server insert failed");
  }
  ok("server registered");

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };

  managerSsh = await connect({
    host: TARGET.host,
    privateKey,
    user: TARGET.user,
  });
  await removeService(dockerClient(managerSsh), "noddle-db-probe-postgres");
  await removeService(dockerClient(managerSsh), "noddle-db-probe-redis");

  for (const name of ["noddle-db-probe-postgres", "noddle-db-probe-redis"]) {
    for (let i = 0; i < 10; i += 1) {
      const res = await execArgv(managerSsh, [
        "sudo",
        "docker",
        "volume",
        "rm",
        name,
      ]);
      if (res.code === 0 || res.stderr.includes("no such volume")) {
        break;
      }
      await sleep(1500);
    }
  }

  const [proj] = await db
    .insert(projects)
    .values({ name: "database-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  const httpRun = async (
    image: string,
    args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    if (!managerSsh) {
      throw new Error("no manager connection");
    }
    return await execArgv(managerSsh, [
      "sudo",
      "docker",
      "run",
      "--rm",
      "--network",
      "noddle-public",
      image,
      ...args,
    ]);
  };

  {
    const password = randomBytes(24).toString("hex");
    const [database] = await db
      .insert(databases)
      .values({
        engine: "postgres",
        environmentId: env?.id ?? "",
        name: "probe-postgres",
        rootPasswordEncrypted: "placeholder",
        rootUser: "noddle",
        serverId: server.id,
        swarmName: "noddle-db-probe-postgres",
      })
      .returning();
    if (!database) {
      throw new Error("postgres database insert failed");
    }
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          password,
          appKey,
          secretContext.databasePassword(database.id)
        ),
      })
      .where(eq(databases.id, database.id));

    console.log("    (provisioning postgres…)");
    await provisionDatabase(ctx, route, verifyBuild("database"), database.id);

    const row = await db.query.databases.findFirst({
      where: eq(databases.id, database.id),
    });
    if (row?.status === "running") {
      ok("postgres provisioned and healthy");
    } else {
      ko(`postgres: status ${row?.status}`);
    }

    const url = `postgresql://noddle:${password}@noddle-db-probe-postgres:5432/noddle`;
    const result = await httpRun("postgres:17-alpine", [
      "psql",
      url,
      "-c",
      "select 1",
    ]);
    if (result.code === 0 && result.stdout.includes("1")) {
      ok("ANOTHER container authenticated and queried postgres");
    } else {
      ko(
        `postgres connection failed (code ${result.code}): ${result.stderr.slice(0, 200)}`
      );
    }

    if (!managerSsh) {
      throw new Error("no manager connection");
    }
    const inspect = await exec(
      managerSsh,
      "sudo docker service inspect noddle-db-probe-postgres"
    );
    if (inspect.stdout.includes(password)) {
      ko("postgres password is visible in plaintext in service inspect");
    } else {
      ok("postgres password is ABSENT from docker service inspect");
    }

    const manager = managerSsh;
    const readResources = async () => {
      const raw = await exec(
        manager,
        "sudo docker service inspect noddle-db-probe-postgres --format '{{json .Spec.TaskTemplate.Resources}}'"
      );
      return JSON.parse(raw.stdout.trim()) as {
        Limits?: { MemoryBytes?: number; NanoCPUs?: number };
        Reservations?: { MemoryBytes?: number };
      };
    };

    await db
      .update(databases)
      .set({
        cpuLimitNanos: 500_000_000,
        memoryLimitBytes: 536_870_912,
        memoryReservationBytes: 268_435_456,
      })
      .where(eq(databases.id, database.id));
    await provisionDatabase(ctx, route, verifyBuild("database"), database.id);

    const withLimits = await readResources();
    if (
      withLimits.Limits?.MemoryBytes === 536_870_912 &&
      withLimits.Limits?.NanoCPUs === 500_000_000 &&
      withLimits.Reservations?.MemoryBytes === 268_435_456
    ) {
      ok("set limits reach the Swarm spec (mem + reservation + CPU)");
    } else {
      ko(`limits in the spec: ${JSON.stringify(withLimits)}`);
    }

    await db
      .update(databases)
      .set({
        cpuLimitNanos: null,
        memoryLimitBytes: null,
        memoryReservationBytes: null,
      })
      .where(eq(databases.id, database.id));
    await provisionDatabase(ctx, route, verifyBuild("database"), database.id);

    const cleared = await readResources();
    if (
      cleared.Limits?.MemoryBytes === undefined &&
      cleared.Limits?.NanoCPUs === undefined &&
      cleared.Reservations?.MemoryBytes === undefined
    ) {
      ok("clearing limits makes them DISAPPEAR from the spec, not set to 0");
    } else {
      ko(`limits not cleared: ${JSON.stringify(cleared)}`);
    }
  }

  {
    const password = randomBytes(24).toString("hex");
    const [database] = await db
      .insert(databases)
      .values({
        engine: "redis",
        environmentId: env?.id ?? "",
        name: "probe-redis",
        rootPasswordEncrypted: "placeholder",
        serverId: server.id,
        swarmName: "noddle-db-probe-redis",
      })
      .returning();
    if (!database) {
      throw new Error("redis database insert failed");
    }
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          password,
          appKey,
          secretContext.databasePassword(database.id)
        ),
      })
      .where(eq(databases.id, database.id));

    console.log("    (provisioning redis…)");
    await provisionDatabase(ctx, route, verifyBuild("database"), database.id);

    const row = await db.query.databases.findFirst({
      where: eq(databases.id, database.id),
    });
    if (row?.status === "running") {
      ok("redis provisioned and healthy");
    } else {
      ko(`redis: status ${row?.status}`);
    }

    const url = `redis://default:${password}@noddle-db-probe-redis:6379`;
    const result = await httpRun("redis:7-alpine", [
      "redis-cli",
      "-u",
      url,
      "ping",
    ]);
    if (result.code === 0 && result.stdout.includes("PONG")) {
      ok("ANOTHER container authenticated and queried redis");
    } else {
      ko(
        `redis connection failed (code ${result.code}): ${result.stderr.slice(0, 200)}`
      );
    }

    if (!managerSsh) {
      throw new Error("no manager connection");
    }
    const redisInspect = await exec(
      managerSsh,
      "sudo docker service inspect noddle-db-probe-redis"
    );
    if (redisInspect.stdout.includes(password)) {
      ko("redis password is visible in plaintext in service inspect");
    } else {
      ok("redis password is ABSENT from docker service inspect");
    }

    const taskId = (
      await exec(
        managerSsh,
        "sudo docker service ps -q --filter desired-state=running noddle-db-probe-redis"
      )
    ).stdout.trim();
    const containerId = (
      await exec(
        managerSsh,
        `sudo docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' ${taskId}`
      )
    ).stdout.trim();
    const top = containerId
      ? await exec(managerSsh, `sudo docker top ${containerId}`)
      : { stdout: "" };
    if (top.stdout.includes(password)) {
      ko("redis password is visible in plaintext in docker top");
    } else {
      ok("redis password is ABSENT from docker top (process argv)");
    }
  }

  const again = await db.query.databases.findFirst({
    where: eq(databases.name, "probe-postgres"),
  });
  if (again) {
    await provisionDatabase(ctx, route, verifyBuild("database"), again.id);
    ok("second provision replayable without error (idempotent)");
  }

  const nodeId = (
    await exec(managerSsh, "sudo docker info --format '{{.Swarm.NodeID}}'")
  ).stdout.trim();
  const managerDocker = dockerClient(managerSsh);
  for (const name of ["noddle-db-probe-postgres", "noddle-db-probe-redis"]) {
    const list = (await managerDocker.listServices({
      filters: JSON.stringify({ name: [name] }),
    })) as unknown as {
      Spec?: {
        Name?: string;
        TaskTemplate?: { Placement?: { Constraints?: string[] } };
      };
    }[];
    const found = list.find((s) => s.Spec?.Name === name);
    const constraints = found?.Spec?.TaskTemplate?.Placement?.Constraints ?? [];
    if (constraints.includes(`node.id==${nodeId}`)) {
      ok(`${name} is pinned to its node — its volume does not travel`);
    } else {
      ko(
        `${name} without constraint: [${constraints.join(", ")}] — Swarm could move it onto an empty volume`
      );
    }
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (managerSsh) {
    try {
      const docker = dockerClient(managerSsh);
      if (!process.env.NODDLE_KEEP) {
        await removeService(docker, "noddle-db-probe-postgres");
        await removeService(docker, "noddle-db-probe-redis");
        await execArgv(managerSsh, [
          "sudo",
          "docker",
          "volume",
          "rm",
          "-f",
          "noddle-db-probe-postgres",
          "noddle-db-probe-redis",
        ]);
        await removeSecretIfExists(docker, "noddle-db-probe-postgres-password");
        await removeSecretIfExists(docker, "noddle-db-probe-redis-password");
      }
    } catch {}
    disconnect(managerSsh);
  }
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);

process.exit(fail === 0 ? 0 : 1);
