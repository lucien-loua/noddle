// tier: vm
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import {
  DATABASE_PORT,
  DEFAULT_DATABASE_IMAGE,
  DEFAULT_DATABASE_USER,
  HAS_NAMED_DATABASE,
} from "@noddle/database-spec";
import type { DatabaseEngine } from "@noddle/database-spec";
import { createDatabase } from "@noddle/db";
import { databases, environments, projects, servers } from "@noddle/db/schema";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
} from "@noddle/ssh-executor";
import { removeService, waitForRunningTask } from "@noddle/swarm-ops";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { provisionDatabase } from "#database";
import { changeDatabasePassword } from "#database-password";
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
const sshKeyId = await seedSshKey(
  db,
  appKey,
  "verify-database-password",
  privateKey
);

const ENGINES: DatabaseEngine[] = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
];
const swarmNameOf = (engine: DatabaseEngine) => `noddle-pw-${engine}`;
const dbNameOf = (engine: DatabaseEngine) =>
  HAS_NAMED_DATABASE[engine] ? "pwdb" : null;

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
  redis: ({ hostName, password, port }) => [
    DEFAULT_DATABASE_IMAGE.redis,
    "redis-cli",
    "-u",
    `redis://default:${encodeURIComponent(password)}@${hostName}:${port}`,
    "ping",
  ],
};

function probeArgvFor(
  engine: DatabaseEngine,
  opts: {
    hostName: string;
    password: string;
    port: number;
    user: string | null;
  }
): string[] {
  const build = PROBE_ARGV[engine];
  if (!build) {
    throw new Error(`unsupported database engine for probe: ${engine}`);
  }
  return build(opts);
}

async function removeSecretsByPrefix(
  docker: ReturnType<typeof dockerClient>,
  prefix: string
): Promise<void> {
  try {
    const list = (await docker.listSecrets({
      filters: JSON.stringify({ name: [prefix] }),
    })) as unknown as { ID?: string; Spec?: { Name?: string } }[];
    for (const secret of list) {
      if (secret.ID && secret.Spec?.Name?.startsWith(prefix)) {
        await docker.getSecret(secret.ID).remove();
      }
    }
  } catch {}
}

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
      name: "password-probe-manager",
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

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };

  managerSsh = await connect({
    host: TARGET.host,
    privateKey,
    user: TARGET.user,
  });
  const managerDocker = dockerClient(managerSsh);

  for (const engine of ENGINES) {
    const name = swarmNameOf(engine);
    await removeService(managerDocker, name);
    await removeSecretsByPrefix(managerDocker, `${name}-password`);
    for (let i = 0; i < 10; i += 1) {
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
      await sleep(1500);
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
      ...probeArgvFor(engine, { hostName, password, port, user }),
    ];

    const res = await execArgv(managerSsh, argv);
    if (engine === "redis") {
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
    await provisionDatabase(
      ctx,
      route,
      verifyBuild("database-password"),
      database.id
    );

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

    const inspect = await exec(
      managerSsh,
      `sudo docker service inspect ${swarmName}`
    );
    if (inspect.stdout.includes(newPassword)) {
      ko(`${engine}: the new password is in plaintext in service inspect`);
    } else {
      ok(`${engine}: the new password is ABSENT from service inspect`);
    }

    console.log("    (forcing task restart…)");
    await exec(managerSsh, `sudo docker service update --force ${swarmName}`);
    await waitForRunningTask(managerDocker, swarmName);

    if (await canConnect(engine, rootUser, newPassword)) {
      ok(`${engine}: after a NEW task, the new password still holds`);
    } else {
      ko(`${engine}: after restart, the new password no longer works`);
    }

    await removeService(managerDocker, swarmName);
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (managerSsh) {
    const managerDocker = dockerClient(managerSsh);
    for (const engine of ENGINES) {
      const name = swarmNameOf(engine);
      await removeService(managerDocker, name).catch(() => {});
      await removeSecretsByPrefix(managerDocker, `${name}-password`);
    }
    disconnect(managerSsh);
  }
  await db.$client.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
