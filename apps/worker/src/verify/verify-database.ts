// STACK_HOST=192.168.252.3 DATABASE_URL=… node apps/worker/src/verify/verify-database.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { databases, environments, projects, servers } from "@noddle/db/schema";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
} from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { eq, inArray } from "drizzle-orm";
import { provisionDatabase, removeSecretIfExists } from "#database";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");
const sshKeyId = await seedSshKey(db, appKey, "verify-database", privateKey);

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [HOST]));

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "database-probe-manager",
      role: "manager",
      sshKeyId,
      sshUser: USER,
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

  managerSsh = await connect({ host: HOST, privateKey, user: USER });
  await removeService(dockerClient(managerSsh), "noddle-db-probe-postgres");
  await removeService(dockerClient(managerSsh), "noddle-db-probe-redis");

  // The VOLUME, not just the service: a named volume SURVIVES
  // `removeService`. Without this, the second run provisions a database with
  // a NEW password onto an EXISTING data directory — and Postgres only applies
  // `POSTGRES_PASSWORD` on first initialization. The test then failed on
  // "password authentication failed" blaming the code, when the fault was its
  // own fixture. Same trap already caught for `verify-backup.ts`.
  //
  // A retry loop: the volume can stay locked for a few moments by the
  // container we just removed.
  for (const name of ["noddle-db-probe-postgres", "noddle-db-probe-redis"]) {
    for (let i = 0; i < 10; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: intentional retry
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
      await new Promise((r) => setTimeout(r, 1500));
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

  // ── Postgres ───────────────────────────────────────────────────────────
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
        // Set EXPLICITLY, to the historical value: this harness's subject is
        // provisioning, not naming. A fixed name keeps fixture cleanup exact
        // (service AND volume). Name collision has its own assertion below.
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
    await provisionDatabase(ctx, route, database.id);

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

    // The real question of this effort: not "it connects" (already proven
    // above with a client-side password), but "is the password ABSENT from
    // what `docker service inspect` reveals to anyone with daemon access".
    // Measured, not deduced.
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

    // ── Resource limits (the Advanced tab) ───────────────────────────────
    //
    // Two directions, and the second is the one that proves something: SET a
    // limit, re-read it in the Swarm spec, then CLEAR it and verify it
    // DISAPPEARS. The spec is replaced wholesale on every provision — only
    // testing the set would let through code that never clears, so a limit
    // you can never lift.
    //
    // Captured in a CONST: `managerSsh` is `Client | undefined` as far as the
    // type is concerned — the guard just above narrows it, but a closure does
    // not retain that narrowing, since the variable could in theory change
    // before the call.
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
    await provisionDatabase(ctx, route, database.id);

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
    await provisionDatabase(ctx, route, database.id);

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

  // ── Redis ──────────────────────────────────────────────────────────────
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
    await provisionDatabase(ctx, route, database.id);

    const row = await db.query.databases.findFirst({
      where: eq(databases.id, database.id),
    });
    if (row?.status === "running") {
      ok("redis provisioned and healthy");
    } else {
      ko(`redis: status ${row?.status}`);
    }

    // `redis://:<pwd>@…` (empty user) fails with redis-cli: without ACL, the
    // URI parser needs the explicit `default` user to correctly extract the
    // password — measured, "AUTH failed" otherwise even though the SAME
    // password passed via `-a` works.
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

    // Same measurement as for postgres, against `service inspect`.
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

    // Redis also carries an explicit shell Command (the generated conf file):
    // the real `ps`/`docker top` risk surface, not the same thing as
    // `service inspect`.
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

  // ── idempotence: replaying provision breaks nothing ────────────────────
  const again = await db.query.databases.findFirst({
    where: eq(databases.name, "probe-postgres"),
  });
  if (again) {
    await provisionDatabase(ctx, route, again.id);
    ok("second provision replayable without error (idempotent)");
  }

  // ── the placement constraint: the test that was missing ────────────────
  //
  // A database is the case where it matters MOST. Its named volume exists only
  // on ITS node, and Swarm does not solve distributed storage: without a
  // constraint, a multi-node cluster can schedule it elsewhere, where it would
  // start on an EMPTY volume — with no error, looking like it works.
  //
  // Earlier code skipped the constraint when the database was hosted by the
  // manager, believing it had no effect: true on one node, false from the
  // second onward. Nothing here saw it, since this test only inspected health.
  const nodeId = (
    await exec(managerSsh, "sudo docker info --format '{{.Swarm.NodeID}}'")
  ).stdout.trim();
  const managerDocker = dockerClient(managerSsh);
  for (const name of ["noddle-db-probe-postgres", "noddle-db-probe-redis"]) {
    // biome-ignore lint/performance/noAwaitInLoops: two services, sequential intentional
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
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
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
        // The secret created by `ensureSecret`: this harness builds it itself,
        // so it is responsible for removing it — `removeSecretIfExists` is only
        // wired into the REAL teardown of a database.
        await removeSecretIfExists(docker, "noddle-db-probe-postgres-password");
        await removeSecretIfExists(docker, "noddle-db-probe-redis-password");
      }
    } catch {
      // best-effort cleanup
    }
    disconnect(managerSsh);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);

// A harness that does not return an exit code cannot be chained: a RED run
// would be indistinguishable from a green one to the caller. And without an
// explicit exit, the Postgres pool keeps the event loop alive, so the process
// never terminates — measured, the last two runs stayed alive after printing
// their result. Same lesson as `execArgv`'s exit code that nothing required
// us to read.
process.exit(fail === 0 ? 0 : 1);
