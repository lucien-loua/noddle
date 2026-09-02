// tier: vm
import { randomBytes } from "node:crypto";

import { loadAppKey } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { serverDiskUsage, servers } from "@noddle/db/schema";
import { connect, disconnect, execArgv } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq } from "drizzle-orm";

import { pruneDocker } from "#prune";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();

const suffix = randomBytes(3).toString("hex");
const ORPHAN = `noddle-toggle-off-${suffix}:v1`;
const DEAD_CONTAINER = `noddle-toggle-off-dead-${suffix}`;

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

const appKey = loadAppKey(process.env.APP_KEY);
const db = createDatabase({ url: DB_URL });
const { privateKey } = TARGET;

async function docker(
  client: SshClient,
  ...argv: string[]
): Promise<{ code: number }> {
  const res = await execArgv(client, ["sudo", "docker", ...argv]);
  return { code: res.code ?? 1 };
}

async function imageExists(client: SshClient, tag: string): Promise<boolean> {
  const res = await docker(client, "image", "inspect", tag);
  return res.code === 0;
}

console.log(`\n\u001B[1mPrune switch — VM ${TARGET.host}\u001B[0m`);

let ssh: SshClient | undefined;
let restoreTo: boolean | undefined;

try {
  const sshKeyId = await seedSshKey(
    db,
    appKey,
    "verify-prune-toggle",
    TARGET.privateKey
  );
  await db.delete(servers).where(eq(servers.host, TARGET.host));
  const [server] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "prune-toggle-probe",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
    })
    .returning();
  if (!server) {
    throw new Error("server insert failed");
  }
  restoreTo = server.pruneEnabled;

  ssh = await connect({
    host: TARGET.host,
    port: 22,
    privateKey,
    user: TARGET.user,
  });

  await docker(ssh, "rm", "-f", DEAD_CONTAINER);
  await docker(ssh, "pull", "alpine:3");
  await docker(ssh, "tag", "alpine:3", ORPHAN);
  await docker(ssh, "run", "--name", DEAD_CONTAINER, ORPHAN, "true");

  await db
    .update(servers)
    .set({ pruneEnabled: false })
    .where(eq(servers.id, server.id));

  const ctx = verifyCtx({ appKey, db });

  const before = await db.query.serverDiskUsage.findMany({
    where: eq(serverDiskUsage.serverId, server.id),
  });
  const result = await pruneDocker(ctx);

  if (await imageExists(ssh, ORPHAN)) {
    ok("pruneEnabled=false: the orphan image is NOT pruned");
  } else {
    ko("DANGER: the image was pruned despite pruneEnabled=false");
  }

  if (result.nodes.length === 0) {
    ok("the disabled node doesn't appear among the PRUNED nodes");
  } else {
    ko(`disabled node counted as pruned: ${JSON.stringify(result.nodes)}`);
  }

  if (result.reconciledFully) {
    ok("the disabled node still counts for reconciliation");
  } else {
    ko(
      `reconciliation stays blocked even though the only server responded${
        result.skipped.length > 0
          ? ` — skipped: ${result.skipped.map((s) => s.reason).join("; ")}`
          : " — nothing was skipped, so the count is off elsewhere"
      }`
    );
  }

  const after = await db.query.serverDiskUsage.findMany({
    where: eq(serverDiskUsage.serverId, server.id),
  });
  if (after.length > before.length) {
    ok("disk usage for the disabled node is still recorded");
  } else {
    ko("no new disk usage row for the disabled node");
  }

  await db
    .update(servers)
    .set({ pruneEnabled: true })
    .where(eq(servers.id, server.id));

  const second = await pruneDocker(ctx);

  if (await imageExists(ssh, ORPHAN)) {
    ko("DANGER: re-enabled, the orphan image still survived");
  } else {
    ok("pruneEnabled=true: the SAME image is pruned this time");
  }
  if (second.nodes.length === 1) {
    ok("the re-enabled node does appear among the pruned nodes");
  } else {
    ko(
      `re-enabled node missing from pruned nodes: ${JSON.stringify(second.nodes)}`
    );
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 4).join("\n"));
  }
} finally {
  if (ssh) {
    await docker(ssh, "rm", "-f", DEAD_CONTAINER);
    await docker(ssh, "image", "rm", "-f", ORPHAN);
    disconnect(ssh);
  }
  if (restoreTo !== undefined) {
    await db
      .update(servers)
      .set({ pruneEnabled: restoreTo })
      .where(eq(servers.host, TARGET.host));
  }
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
