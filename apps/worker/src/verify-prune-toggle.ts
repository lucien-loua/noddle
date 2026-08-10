// The prune switch, against the REAL VM.
//
//   STACK_HOST=192.168.252.3 node apps/worker/src/verify-prune-toggle.ts
//
// Isolated from verify-prune.ts rather than added to it: this change WRAPS
// code already covered 17/17 (pruneNode, imageTagsOn, recordDiskUsage) under
// a simple boolean guard. The only new surface is that guard.
//
// ⚠ Flips the server ALREADY registered at this host, creates NO row. A
// second server on the same (host, port, user) would violate the unique
// index — and deleting the real server to seed a synthetic one would take
// with it the services and databases that reference it as `restrict`. The
// original value is restored in `finally`, regardless of the outcome.
//
// What would make this pass for the wrong reason, laid out before writing
// the assertions:
//
//   - "nothing was pruned" isn't sufficient on its own: a bug that ALWAYS
//     blocked pruning would also be green. The test therefore compares
//     disabled then re-enabled, on the SAME server, the SAME image.
//   - "the disabled node doesn't appear in result.nodes" doesn't prove it
//     was PROBED. `reconciledFully` is checked separately, along with
//     whether a disk usage row was actually written.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@noddle/db";
import { serverDiskUsage, servers } from "@noddle/db/schema";
import { loadAppKey } from "@noddle/shared/crypto";
import {
  connect,
  disconnect,
  execArgv,
  type SshClient,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import type { DeployContext } from "#deploy";
import { pruneDocker } from "#prune";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const suffix = randomBytes(3).toString("hex");
const ORPHAN = `noddle-toggle-off-${suffix}:v1`;
const DEAD_CONTAINER = `noddle-toggle-off-dead-${suffix}`;

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

const appKey = loadAppKey(process.env.APP_KEY);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");

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

console.log(`\n\x1b[1mPrune switch — VM ${HOST}\x1b[0m`);

let ssh: SshClient | undefined;
let restoreTo: boolean | undefined;

try {
  const server = await db.query.servers.findFirst({
    where: eq(servers.host, HOST),
  });
  if (!server) {
    throw new Error(
      `no server registered for ${HOST} — this bench flips the already-present server, it creates nothing`
    );
  }
  restoreTo = server.pruneEnabled;

  ssh = await connect({ host: HOST, port: 22, privateKey, user: USER });

  await docker(ssh, "rm", "-f", DEAD_CONTAINER);
  await docker(ssh, "pull", "alpine:3");
  await docker(ssh, "tag", "alpine:3", ORPHAN);
  await docker(ssh, "run", "--name", DEAD_CONTAINER, ORPHAN, "true");

  await db
    .update(servers)
    .set({ pruneEnabled: false })
    .where(eq(servers.id, server.id));

  const ctx: DeployContext = {
    appKey,
    db,
    logRoot: "/tmp/noddle-prune-toggle-logs",
    networkName: "noddle-public",
  };

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
    ko("reconciliation stays blocked even though the only server responded");
  }

  const after = await db.query.serverDiskUsage.findMany({
    where: eq(serverDiskUsage.serverId, server.id),
  });
  if (after.length > before.length) {
    ok("disk usage for the disabled node is still recorded");
  } else {
    ko("no new disk usage row for the disabled node");
  }

  // ── The symmetric case: re-enabled, the SAME image goes away ─────────────
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
} catch (err) {
  ko(`exception: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 4).join("\n"));
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
      .where(eq(servers.host, HOST));
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
