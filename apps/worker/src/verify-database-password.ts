// STACK_HOST=192.168.252.3 DATABASE_URL=… node apps/worker/src/verify-database-password.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { databases, environments, projects, servers } from "@noddle/db/schema";
import {
  DATABASE_PORT,
  type DatabaseEngine,
  DEFAULT_DATABASE_IMAGE,
  DEFAULT_DATABASE_USER,
  HAS_NAMED_DATABASE,
} from "@noddle/shared/database-engines";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
} from "@noddle/ssh-executor";
import { removeService, waitForRunningTask } from "@noddle/swarm-ops";
import { eq, inArray } from "drizzle-orm";
import { provisionDatabase } from "#database";
import { changeDatabasePassword } from "#database-password";
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
const sshKeyId = await seedSshKey(
  db,
  appKey,
  "verify-database-password",
  privateKey
);

/** The five engines, each with a fixed Swarm name for cleanup. */
const ENGINES: DatabaseEngine[] = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
];
const swarmNameOf = (engine: DatabaseEngine) => `noddle-pw-${engine}`;
/** The database name created by the image, for engines that have one. */
const dbNameOf = (engine: DatabaseEngine) =>
  HAS_NAMED_DATABASE[engine] ? "pwdb" : null;

/**
 * Clean secrets BY PREFIX, never by exact name.
 *
 * Rotation RENAMES the secret (`<service>-password-<timestamp>`): a cleanup
 * on `<service>-password` would leave behind every secret a password change
 * created, and the second harness run would execute against a dirty fixture.
 */
async function removeSecretsByPrefix(
  docker: ReturnType<typeof dockerClient>,
  prefix: string
): Promise<void> {
  try {
    const list = (await docker.listSecrets({
      filters: JSON.stringify({ name: [prefix] }),
    })) as unknown as Array<{ ID?: string; Spec?: { Name?: string } }>;
    for (const secret of list) {
      if (secret.ID && secret.Spec?.Name?.startsWith(prefix)) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential removal
        await docker.getSecret(secret.ID).remove();
      }
    }
  } catch {
    // Best-effort, as everywhere else for secrets.
  }
}

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
      name: "password-probe-manager",
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

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };

  managerSsh = await connect({ host: HOST, privateKey, user: USER });
  const managerDocker = dockerClient(managerSsh);

  // Fixture: service, VOLUME, and SECRET. The volume survives `removeService`,
  // so without this the second run provisions a fresh password onto existing
  // data — the engine only applies its initial password on the FIRST
  // initialization, and the test would fail blaming the code when the fault
  // is its own fixture. Trap already paid for on `verify-backup` and
  // `verify-database`.
  for (const engine of ENGINES) {
    const name = swarmNameOf(engine);
    // biome-ignore lint/performance/noAwaitInLoops: one engine at a time, intentionally
    await removeService(managerDocker, name);
    await removeSecretsByPrefix(managerDocker, `${name}-password`);
    for (let i = 0; i < 10; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: intentional retry
      const res = await execArgv(managerSsh, [
        "sudo",
        "docker",
        "volume",
        "rm",
        name,
      ]);
      if (
        res.code === 0 ||
        /no such volume|volume .* not found/i.test(res.stderr)
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const [proj] = await db
    .insert(projects)
    .values({ name: "password-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  /**
   * Connect FROM ANOTHER CONTAINER, on the same overlay — exactly what an
   * attached application does. Returns `true` if authentication succeeds,
   * `false` if it is refused.
   *
   * Probe argv is a table keyed by engine (same shape as DUMP_SPECS /
   * RESTORE_SPECS) so a sixth engine fails to compile here, not at runtime.
   */
  const PROBE_ARGV: Record<
    DatabaseEngine,
    (opts: {
      hostName: string;
      password: string;
      port: number;
      user: string | null;
    }) => string[]
  > = {
    mariadb: ({ hostName, password, user }) => [
      "-e",
      `MYSQL_PWD=${password}`,
      DEFAULT_DATABASE_IMAGE.mariadb,
      "mariadb",
      "-h",
      hostName,
      "-u",
      user ?? "root",
      "-e",
      "select 1",
    ],
    mongo: ({ hostName, password, port, user }) => [
      DEFAULT_DATABASE_IMAGE.mongo,
      "mongosh",
      `mongodb://${user}:${encodeURIComponent(password)}@${hostName}:${port}/admin`,
      "--quiet",
      "--eval",
      "db.runCommand({ ping: 1 }).ok",
    ],
    mysql: ({ hostName, password, user }) => [
      "-e",
      `MYSQL_PWD=${password}`,
      DEFAULT_DATABASE_IMAGE.mysql,
      "mysql",
      "-h",
      hostName,
      "-u",
      user ?? "root",
      "-e",
      "select 1",
    ],
    postgres: ({ hostName, password, port, user }) => [
      DEFAULT_DATABASE_IMAGE.postgres,
      "psql",
      `postgresql://${user}:${encodeURIComponent(password)}@${hostName}:${port}/${dbNameOf("postgres")}`,
      "-c",
      "select 1",
    ],
    // Explicit `default:` for the user — without ACL, redis-cli's URI
    // parser needs the name to recognize the password.
    redis: ({ hostName, password, port }) => [
      DEFAULT_DATABASE_IMAGE.redis,
      "redis-cli",
      "-u",
      `redis://default:${encodeURIComponent(password)}@${hostName}:${port}`,
      "ping",
    ],
  };

  const canConnect = async (
    engine: DatabaseEngine,
    user: string | null,
    password: string
  ): Promise<boolean> => {
    if (!managerSsh) {
      throw new Error("no manager connection");
    }
    const hostName = swarmNameOf(engine);
    const port = DATABASE_PORT[engine];
    const argv = [
      "sudo",
      "docker",
      "run",
      "--rm",
      "--network",
      "noddle-public",
      ...PROBE_ARGV[engine]({ hostName, password, port, user }),
    ];

    const res = await execArgv(managerSsh, argv);
    if (engine === "redis") {
      // redis-cli returns 0 even on `WRONGPASS`: the OUTPUT is what decides.
      // Reading the exit code would have made the "old is refused" assertion
      // green no matter what.
      return res.code === 0 && res.stdout.includes("PONG");
    }
    return res.code === 0;
  };

  for (const engine of ENGINES) {
    console.log(`\n── ${engine} ─────────────────────────────────`);
    const swarmName = swarmNameOf(engine);
    const rootUser = DEFAULT_DATABASE_USER[engine];
    const oldPassword = randomBytes(18).toString("hex");
    const newPassword = randomBytes(18).toString("hex");

    // biome-ignore lint/performance/noAwaitInLoops: one engine at a time: the VM is 2 GB, five databases in parallel do not fit
    const [database] = await db
      .insert(databases)
      .values({
        databaseName: dbNameOf(engine),
        engine,
        environmentId: env?.id ?? "",
        name: `pw-${engine}`,
        rootPasswordEncrypted: "placeholder",
        rootUser,
        serverId: server.id,
        swarmName,
      })
      .returning();
    if (!database) {
      throw new Error(`${engine} insert failed`);
    }
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          oldPassword,
          appKey,
          secretContext.databasePassword(database.id)
        ),
      })
      .where(eq(databases.id, database.id));

    console.log(`    (provisioning ${engine}…)`);
    await provisionDatabase(ctx, route, database.id);

    if (await canConnect(engine, rootUser, oldPassword)) {
      ok(`${engine}: the INITIAL password is accepted`);
    } else {
      ko(`${engine}: the initial password is refused — broken fixture`);
      continue;
    }

    console.log("    (changing password…)");
    await changeDatabasePassword(ctx, database.id, newPassword);

    if (await canConnect(engine, rootUser, newPassword)) {
      ok(`${engine}: the NEW password is accepted`);
    } else {
      ko(`${engine}: the new password is REFUSED`);
    }

    // The assertion that gives meaning to the previous one.
    if (await canConnect(engine, rootUser, oldPassword)) {
      ko(`${engine}: the OLD password is still accepted`);
    } else {
      ok(`${engine}: the old password is refused`);
    }

    const row = await db.query.databases.findFirst({
      where: eq(databases.id, database.id),
    });
    const stored = row
      ? decryptSecret(
          row.rootPasswordEncrypted,
          appKey,
          secretContext.databasePassword(database.id)
        )
      : "";
    if (stored === newPassword) {
      ok(`${engine}: the row carries the new password`);
    } else {
      ko(`${engine}: the row does NOT carry the new password`);
    }

    // Is the new password ABSENT from what the daemon reveals?
    const inspect = await exec(
      managerSsh,
      `sudo docker service inspect ${swarmName}`
    );
    if (inspect.stdout.includes(newPassword)) {
      ko(`${engine}: the new password is in plaintext in service inspect`);
    } else {
      ok(`${engine}: the new password is ABSENT from service inspect`);
    }

    // DURABILITY: a NEW task, so a container that re-reads the rotated secret
    // and a health probe that must pass with the new password. Without this
    // step, Redis (changed in memory) and MySQL (whose probe reads the secret)
    // would go green while being broken on the first reschedule.
    console.log("    (forcing task restart…)");
    await exec(managerSsh, `sudo docker service update --force ${swarmName}`);
    await waitForRunningTask(managerDocker, swarmName);

    if (await canConnect(engine, rootUser, newPassword)) {
      ok(`${engine}: after a NEW task, the new password still holds`);
    } else {
      ko(`${engine}: after restart, the new password no longer works`);
    }

    // Tear down RIGHT AWAY, before the next engine. The VM is 2 GB — the size
    // of a real cheap VPS, by design — and leaving all five engines running
    // makes the fourth provision fail with "did not converge within 180s", a
    // message that blames the code when the fault is the harness's memory.
    // Measured: mongo failed exactly there.
    await removeService(managerDocker, swarmName);
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (managerSsh) {
    const managerDocker = dockerClient(managerSsh);
    for (const engine of ENGINES) {
      const name = swarmNameOf(engine);
      // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
      await removeService(managerDocker, name).catch(() => undefined);
      await removeSecretsByPrefix(managerDocker, `${name}-password`);
    }
    disconnect(managerSsh);
  }
  await db.$client.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
