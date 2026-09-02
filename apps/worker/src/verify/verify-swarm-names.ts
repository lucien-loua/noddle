// tier: vm
import { randomBytes } from "node:crypto";

import { encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { databases, environments, projects, servers } from "@noddle/db/schema";
import { newDatabaseSwarmName } from "@noddle/shared/swarm-names";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
} from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq } from "drizzle-orm";

import { provisionDatabase } from "#database";
import { seedSshKey, verifyCtx, verifyBuild } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();
const NETWORK = "noddle-public";

const SHARED_NAME = "dup";

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
const sshKeyId = await seedSshKey(db, appKey, "verify-swarm-names", privateKey);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

async function sweepLeftovers(
  client: Awaited<ReturnType<typeof connect>>
): Promise<void> {
  const docker = dockerClient(client);
  const services = await docker.listServices();
  for (const svc of services) {
    const name = svc.Spec?.Name;
    if (
      name &&
      (name.startsWith(`ndb-${SHARED_NAME}-`) ||
        name === `noddle-db-${SHARED_NAME}`)
    ) {
      await removeService(docker, name);
    }
  }

  await exec(
    client,
    `for i in $(seq 1 20); do
       left=$(sudo docker volume ls -q | grep -E '^(ndb-${SHARED_NAME}-|noddle-db-${SHARED_NAME}$)' || true)
       [ -z "$left" ] && exit 0
       for v in $left; do sudo docker volume rm "$v" >/dev/null 2>&1 || true; done
       sleep 1
     done; exit 0`
  );
}

function psql(host: string, password: string, sql: string): string[] {
  return [
    "sudo",
    "docker",
    "run",
    "--rm",
    "--network",
    NETWORK,
    "-e",
    `PGPASSWORD=${password}`,
    "postgres:17-alpine",
    "psql",
    "-h",
    host,
    "-U",
    "noddle",
    "-d",
    "noddle",
    "-tAc",
    sql,
  ];
}

await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers);

try {
  ssh = await connect({ host: TARGET.host, privateKey, user: TARGET.user });
  await sweepLeftovers(ssh);

  const [server] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "swarm-names-probe",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("server insertion failed");
  }

  const [project] = await db
    .insert(projects)
    .values({ name: "dup-proj" })
    .returning();

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: NETWORK };

  const makeDatabase = async (
    envName: string
  ): Promise<{ id: string; password: string }> => {
    const [environment] = await db
      .insert(environments)
      .values({ name: envName, projectId: project?.id ?? "" })
      .returning();

    const password = randomBytes(24).toString("hex");
    const [row] = await db
      .insert(databases)
      .values({
        engine: "postgres",
        environmentId: environment?.id ?? "",
        name: SHARED_NAME,
        rootPasswordEncrypted: "placeholder",
        rootUser: "noddle",
        serverId: server.id,
        swarmName: "placeholder",
      })
      .returning();
    if (!row) {
      throw new Error(`database insertion ${envName} failed`);
    }
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          password,
          appKey,
          secretContext.databasePassword(row.id)
        ),
        swarmName: newDatabaseSwarmName(row),
      })
      .where(eq(databases.id, row.id));

    return { id: row.id, password };
  };

  const prod = await makeDatabase("production");
  const staging = await makeDatabase("staging");

  const nameOf = async (id: string): Promise<string> => {
    const row = await db.query.databases.findFirst({
      where: eq(databases.id, id),
    });
    return row?.swarmName ?? "";
  };
  const prodName = await nameOf(prod.id);
  const stagingName = await nameOf(staging.id);

  if (prodName === stagingName) {
    ko(`SAME name on both sides: ${prodName}`);
  } else {
    ok(`distinct names: ${prodName} ≠ ${stagingName}`);
  }

  if (prodName.length <= 63 && stagingName.length <= 63) {
    ok(`both fit under 63 (${prodName.length}, ${stagingName.length})`);
  } else {
    ko(`name too long: ${prodName.length}, ${stagingName.length}`);
  }

  await provisionDatabase(ctx, route, verifyBuild("swarm-names"), prod.id);
  await provisionDatabase(ctx, route, verifyBuild("swarm-names"), staging.id);

  const docker = dockerClient(ssh);
  const running = (await docker.listServices())
    .map((s) => s.Spec?.Name ?? "")
    .filter((n) => n.startsWith(`ndb-${SHARED_NAME}-`));
  if (running.length === 2) {
    ok(`two distinct Swarm services are running: ${running.join(", ")}`);
  } else {
    ko(`expected 2 services, found ${running.length}: ${running.join(", ")}`);
  }

  const vols = await exec(
    ssh,
    `sudo docker volume ls -q | grep -E '^ndb-${SHARED_NAME}-' | sort | tr '\\n' ' '`
  );
  const volNames = vols.stdout.trim().split(/\s+/).filter(Boolean);
  if (volNames.length === 2) {
    ok(`two distinct volumes: ${volNames.join(", ")}`);
  } else {
    ko(`expected 2 volumes, found ${volNames.length}: ${vols.stdout.trim()}`);
  }

  const wrote = await execArgv(
    ssh,
    psql(
      prodName,
      prod.password,
      "CREATE TABLE marker (who text); INSERT INTO marker VALUES ('production');"
    )
  );
  if (wrote.code === 0) {
    ok("write into the production database");
  } else {
    ko(`write impossible: ${wrote.stderr.slice(0, 200)}`);
  }

  const seen = await execArgv(
    ssh,
    psql(
      stagingName,
      staging.password,
      "SELECT count(*) FROM information_schema.tables WHERE table_name='marker';"
    )
  );
  const count = seen.stdout.trim();
  if (seen.code === 0 && count === "0") {
    ok("the table written in production is INVISIBLE from staging");
  } else if (seen.code === 0 && count === "1") {
    ko("SAME VOLUME: staging sees the production table");
  } else {
    ko(
      `staging read impossible (code ${seen.code}): ${seen.stderr.slice(0, 200)}`
    );
  }

  const wrongKey = await execArgv(
    ssh,
    psql(stagingName, prod.password, "SELECT 1;")
  );
  if (wrongKey.code === 0) {
    ko("staging accepts the production password — same instance?");
  } else {
    ok("the production password is refused by staging");
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  console.log(error instanceof Error ? error.stack : "");
} finally {
  if (ssh) {
    await sweepLeftovers(ssh).catch(() => {});
    disconnect(ssh);
  }
}

console.log(`\n${pass} ok, ${fail} ko`);
process.exit(fail === 0 ? 0 : 1);
