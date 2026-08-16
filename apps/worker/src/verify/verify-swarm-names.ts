// A database's Swarm name can no longer collide — against a REAL VM.
//
// What's tested here is NOT that two strings differ: that's just form, and
// a test of the pure function would pass green without saying anything
// about the product. What's tested is the CONSEQUENCE the collision had —
// two `main` databases, one in production and one in staging, shared the
// same Swarm service AND THE SAME NAMED VOLUME. The second one therefore
// started on the first one's data, without an error, looking like it worked.
//
// Hence the assertion that matters: we WRITE a row in one and verify it's
// INVISIBLE from the other. It would fail on the old code.
//
//   STACK_HOST=192.168.252.3 DATABASE_URL=… node apps/worker/src/verify/verify-swarm-names.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { eq } from "drizzle-orm";
import { provisionDatabase } from "#database";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");
const NETWORK = "noddle-public";

/** The SHARED name. That's the whole point: the same label on both sides. */
const SHARED_NAME = "dup";

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
const sshKeyId = await seedSshKey(db, appKey, "verify-swarm-names", privateKey);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

/**
 * Removes services AND volumes left by a previous run.
 *
 * By PREFIX: the name now carries 8 hex digits drawn from the id, so it
 * changes on every run and an exact name is no longer enough. Without this
 * sweep, every interrupted run would leave one more orphan behind — and
 * above all a VOLUME, which survives `removeService` and would make the
 * next database start on existing data (the trap already paid on
 * `verify-backup`).
 */
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
      // biome-ignore lint/performance/noAwaitInLoops: intentional sequential cleanup
      await removeService(docker, name);
    }
  }

  // The volume carries the SAME name as the service. A retry loop: it stays
  // locked for a few moments by the container we just removed.
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

/** A SQL query against the database, via a disposable container on the same overlay. */
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
// ALL servers, not just this bench's own. `connectForDeploy` finds the
// manager via `findFirst(role='manager')`: as soon as TWO remain in the
// database, it arbitrarily picks one. A server left over by another script
// then makes this one fail on "malformed ciphertext", i.e. on ANOTHER row's
// key — a failure that blames the code when the fault is in the fixture
// setup. Measured: that's exactly what happened.
await db.delete(servers);

try {
  ssh = await connect({ host: HOST, privateKey, user: USER });
  await sweepLeftovers(ssh);

  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "swarm-names-probe",
      role: "manager",
      sshKeyId,
      sshUser: USER,
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

  // ── two databases, SAME name, two environments ───────────────────────────
  //
  // Reproduces `connectDatabase` to the letter, including its ordering: the
  // row is inserted with placeholders, then completed once the id is known.
  // The password requires it (the AAD binds it to the row) and so does the
  // Swarm name (it carries 8 hex digits).
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

  // Swarm's ceiling, measured: beyond 63, creation is REFUSED.
  if (prodName.length <= 63 && stagingName.length <= 63) {
    ok(`both fit under 63 (${prodName.length}, ${stagingName.length})`);
  } else {
    ko(`name too long: ${prodName.length}, ${stagingName.length}`);
  }

  // ── REAL provisioning of both ─────────────────────────────────────────────
  await provisionDatabase(ctx, route, prod.id);
  await provisionDatabase(ctx, route, staging.id);

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

  // ── THE ASSERTION THAT MATTERS: is the data isolated? ─────────────────────
  //
  // Everything before this could pass while both databases read the same
  // directory. Only a write on one side, invisible from the other, proves it.
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

  // And symmetrically: each responds correctly with ITS OWN password, which
  // rules out having queried the same instance twice.
  const wrongKey = await execArgv(
    ssh,
    psql(stagingName, prod.password, "SELECT 1;")
  );
  if (wrongKey.code === 0) {
    ko("staging accepts the production password — same instance?");
  } else {
    ok("the production password is refused by staging");
  }
} catch (err) {
  ko(`exception: ${err instanceof Error ? err.message : String(err)}`);
  console.log(err instanceof Error ? err.stack : "");
} finally {
  if (ssh) {
    await sweepLeftovers(ssh).catch(() => {
      // best-effort cleanup
    });
    disconnect(ssh);
  }
}

console.log(`\n${pass} ok, ${fail} ko`);
process.exit(fail === 0 ? 0 : 1);
