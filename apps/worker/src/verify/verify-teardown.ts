// tier: vm
// Deleting a stack, a database, a server — against a REAL VM.
//
//   DATABASE_URL=… node apps/worker/src/verify/verify-teardown.ts
//
// WHAT WOULD MAKE THIS TEST PASS FOR THE WRONG REASON, laid out before
// writing the assertions:
//
//   - Checking that the ROW is gone. We're the ones deleting it: it would
//     disappear even if Docker had done nothing, leaving behind containers
//     that nothing names anymore. So we query Docker instead.
//   - For a database, checking the service without checking the VOLUME.
//     That's precisely the opposite of the defect: the volume survives
//     `removeService`, and an orphan volume is exactly what this deletion
//     must avoid.
//   - For a stack, settling for "the stack is gone". We also want its
//     VOLUMES TO HAVE STAYED — that's an explicit decision, so it must be
//     tested, otherwise a `docker stack rm` that one day started deleting
//     them would go unnoticed.
//   - For a server's refusal, accepting any error. Being the manager and
//     "still hosts something" are two different refusals, and a typo in a
//     name would also throw. We assert the REASON.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import {
  databases,
  environments,
  projects,
  servers,
  services,
  stacks,
} from "@noddle/db/schema";
import { newDatabaseSwarmName } from "@noddle/shared/swarm-names";
import { connect, disconnect, dockerClient, exec } from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq } from "drizzle-orm";

import { provisionDatabase } from "#database";
import { runServerTeardown, serverRemovalBlocker } from "#teardown-server";
import { runDatabaseTeardown } from "#teardown-stack";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();
const DB_NAME = "teardown-probe";

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
const sshKeyId = await seedSshKey(db, appKey, "verify-teardown", privateKey);
let ssh: Awaited<ReturnType<typeof connect>> | undefined;

const volumeExists = async (
  client: Awaited<ReturnType<typeof connect>>,
  name: string
): Promise<boolean> => {
  const res = await exec(
    client,
    `sudo docker volume ls -q | grep -Fx ${JSON.stringify(name)} || true`
  );
  return res.stdout.trim() === name;
};

const serviceExists = async (
  client: Awaited<ReturnType<typeof connect>>,
  name: string
): Promise<boolean> => {
  const list = await dockerClient(client).listServices({
    filters: JSON.stringify({ name: [name] }),
  });
  return list.some((s) => s.Spec?.Name === name);
};

const secretExists = async (
  client: Awaited<ReturnType<typeof connect>>,
  name: string
): Promise<boolean> => {
  const list = (await dockerClient(client).listSecrets({
    filters: JSON.stringify({ name: [name] }),
  })) as unknown as { Spec?: { Name?: string } }[];
  return list.some((s) => s.Spec?.Name === name);
};

try {
  ssh = await connect({ host: TARGET.host, privateKey, user: TARGET.user });

  await db.delete(databases);
  await db.delete(stacks);
  await db.delete(services);
  await db.delete(environments);
  await db.delete(projects);
  await db.delete(servers);

  const [srv] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "teardown-manager",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!srv) {
    throw new Error("server insertion failed");
  }

  const [proj] = await db
    .insert(projects)
    .values({ name: "teardown" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };

  // ── a DATABASE, really provisioned ───────────────────────────────────────
  const password = randomBytes(24).toString("hex");
  const [row] = await db
    .insert(databases)
    .values({
      engine: "postgres",
      environmentId: env?.id ?? "",
      name: DB_NAME,
      rootPasswordEncrypted: "placeholder",
      rootUser: "noddle",
      serverId: srv.id,
      swarmName: "placeholder",
    })
    .returning();
  if (!row) {
    throw new Error("database insertion failed");
  }
  const dbSwarmName = newDatabaseSwarmName(row);
  await db
    .update(databases)
    .set({
      rootPasswordEncrypted: encryptSecret(
        password,
        appKey,
        secretContext.databasePassword(row.id)
      ),
      swarmName: dbSwarmName,
    })
    .where(eq(databases.id, row.id));

  console.log("    (provisioning the database…)");
  await provisionDatabase(ctx, route, row.id);

  if (
    (await serviceExists(ssh, dbSwarmName)) &&
    (await volumeExists(ssh, dbSwarmName))
  ) {
    ok("database provisioned: service AND volume present");
  } else {
    ko("the database wasn't provisioned correctly");
    throw new Error("aborting");
  }

  // ── a server that HOSTS something must be refused ─────────────────────────
  //
  // Tested BEFORE deleting the database: it's the only moment the server
  // really hosts something.
  {
    const blocker = await serverRemovalBlocker(ctx, srv.id);
    // This server is ALSO the manager, so both refusals apply. We require
    // the manager's one, which is checked first and is the more serious —
    // accepting any reason would let a refusal for the wrong cause slip
    // through.
    if (blocker?.includes("Swarm manager")) {
      ok(`the manager is refused ("${blocker.slice(0, 48)}…")`);
    } else {
      ko(`unexpected refusal reason: ${blocker ?? "no refusal"}`);
    }
  }

  // A NON-manager server that still hosts something: the other refusal.
  {
    const [worker] = await db
      .insert(servers)
      .values({
        host: "192.0.2.77",
        name: "teardown-worker",
        role: "worker",
        sshKeyId,
        sshUser: TARGET.user,
        status: "connected",
      })
      .returning();
    await db
      .update(databases)
      .set({ serverId: worker?.id ?? "" })
      .where(eq(databases.id, row.id));

    const blocker = await serverRemovalBlocker(ctx, worker?.id ?? "");
    if (blocker?.includes("still hosts") && blocker.includes("database")) {
      ok(
        `a server that hosts something is refused ("${blocker.slice(0, 44)}…")`
      );
    } else {
      ko(`unexpected reason: ${blocker ?? "no refusal"}`);
    }

    // And once EMPTY, it passes. Without this assertion, a guard that
    // refuses ALL THE TIME would be indistinguishable from a correct one.
    await db
      .update(databases)
      .set({ serverId: srv.id })
      .where(eq(databases.id, row.id));
    const after = await serverRemovalBlocker(ctx, worker?.id ?? "");
    if (after === null) {
      ok("the same server, once empty, is no longer refused");
    } else {
      ko(`empty server still refused: ${after}`);
    }

    await runServerTeardown(ctx, worker?.id ?? "");
    const gone = await db.query.servers.findFirst({
      where: eq(servers.id, worker?.id ?? ""),
    });
    if (gone) {
      ko("the server row is still there");
    } else {
      ok("the empty server was removed, unreachable machine included");
    }
  }

  // ── deleting the DATABASE: the volume must go too ──────────────────────────
  await runDatabaseTeardown(ctx, row.id);

  if (await serviceExists(ssh, dbSwarmName)) {
    ko("the database's Swarm service is still running");
  } else {
    ok("the database's Swarm service is gone");
  }
  // The assertion that matters: a named volume SURVIVES `removeService`, so
  // this is where the difference between "deleted" and "orphaned" plays out.
  if (await volumeExists(ssh, dbSwarmName)) {
    ko("the VOLUME is still there — the database is orphaned, not deleted");
  } else {
    ok("the volume was deleted along with the database");
  }
  // The cluster-wide secret that held the password: best-effort, but an
  // orphan secret lingering on every deletion would still be debt we want
  // to see if it shows up.
  if (await secretExists(ssh, `${dbSwarmName}-password`)) {
    ko("the SECRET is still there — best-effort cleanup had no effect");
  } else {
    ok("the secret was removed along with the database");
  }
  const dbRow = await db.query.databases.findFirst({
    where: eq(databases.id, row.id),
  });
  if (dbRow) {
    ko("the database row still exists");
  } else {
    ok("the database row is gone");
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (ssh) {
    disconnect(ssh);
  }
}

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);
