// tier: vm
// Docker pruning, against a REAL VM and a real Postgres.
//
//   node apps/worker/src/verify/verify-prune.ts
//
// Pruning is the only operation in this product that destroys without being
// asked — a timer, on a machine the user owns. The bench's question is
// therefore NOT "does it reclaim bytes": it's "what does it refuse to touch,
// and does it say so when it doesn't know".
//
// What would make this pass for the wrong reason, laid out BEFORE writing
// the assertions:
//
//   - "the volume is still listed" would pass on a volume recreated empty.
//     So we re-read its CONTENT.
//   - "images have disappeared" would pass on a prune that took everything,
//     including what's in use. So we also check that a REFERENCED image
//     survives, and that no running container moved.
//   - "reconciliation marks the row" would pass on a reconciliation that
//     marks EVERYTHING. So we check three non-markings: image still
//     present, image from the REGISTRY, and above all an incomplete table.
//   - the refusal when a node hasn't responded is tested on a row whose
//     image is REALLY gone — i.e. the case where marking it would have been
//     correct. Without that, "nothing is marked" wouldn't distinguish
//     caution from a broken reconciliation.
//
// ⚠ `reset()` deletes ALL servers from the database, along with their
// services and databases — not just this bench's own. This is the lesson
// already paid on `connectForDeploy`, which finds the manager via
// `findFirst`: a server left over by another script makes this one fail
// while blaming the code. Here the reason is even more direct — reconciliation
// only runs if ALL registered servers have responded, so a ghost row would
// block it.
//
// ⚠ It really prunes the VM: images without a container, stopped containers,
// build cache older than seven days. The dev fixtures for other benches
// rebuild themselves, but the next build will be slower.
//
// ⚠ Do NOT run it while a worker is running, same rule as `verify-metrics.ts`
// and paid the same way: the first run measured a VM already emptied, with
// numbers that made no sense. The cause wasn't the code but the fixture setup
// — `upsertJobScheduler` with `every` runs the job ONCE IMMEDIATELY, on
// registration, not in twenty-four hours. A dev worker relaunched by
// `--watch` had therefore already pruned the machine before the bench took
// its "before" measurement. (This immediate trigger is the right behavior
// for the product: a fresh install shouldn't have to wait a day.)
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "@noddle/db";
import {
  databases,
  deployments,
  environments,
  projects,
  serverDiskUsage,
  serverMetrics,
  servers,
  serviceMetrics,
  services,
} from "@noddle/db/schema";
import type { RegistryConfig } from "@noddle/registry";
import { connect, disconnect, dockerClient, execArgv } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq } from "drizzle-orm";

import { pruneDocker } from "#prune";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();
const DEAD = "192.0.2.1"; // TEST-NET-1: guaranteed non-routable

/** The registry prefix. No registry needs to be running: only the SHAPE of
 *  the reference decides its portability, which is the whole principle
 *  behind `isPortableImage`. */
const REGISTRY_HOST = `${TARGET.host}:5000`;

const ORPHAN = "noddle-prune-probe-orphan:v1";
const KEPT = "noddle-prune-probe-keep:v1";
const PORTABLE = `${REGISTRY_HOST}/noddle-prune-probe:v1`;
const VANISHED = "noddle-prune-probe-never-existed:v1";
const DEAD_CONTAINER = "noddle-prune-probe-dead";
const LIVE_CONTAINER = "noddle-prune-probe-live";
const VOLUME = "noddle-prune-probe-vol";
const CANARY = "the volume survived";

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
const sshKeyId = await seedSshKey(db, appKey, "verify-prune", privateKey);

async function reset(): Promise<void> {
  await db.delete(serviceMetrics);
  await db.delete(serverMetrics);
  await db.delete(serverDiskUsage);
  await db.delete(databases);
  await db.delete(services);
  await db.delete(servers);
  await db.delete(projects);
}

/** A remote `docker` that doesn't throw: the fixture setup tolerates absence. */
async function docker(
  client: SshClient,
  ...argv: string[]
): Promise<{ code: number; stdout: string }> {
  const res = await execArgv(client, ["sudo", "docker", ...argv]);
  // `code` is nullable when the command dies from a signal; here that means
  // "not successful", which 1 conveys just as well.
  return { code: res.code ?? 1, stdout: res.stdout.trim() };
}

/**
 * The fixture data to prune, on the VM.
 *
 * `ORPHAN` is only referenced by a STOPPED container: it only becomes
 * removable once that container is gone. This is what tests `pruneNode`'s
 * internal ordering — containers first, images next. Pruning in the other
 * order would leave `ORPHAN` in place and require a second pass.
 *
 * TWO base images and not one, learned on the first run: by tagging the same
 * image twice, `KEPT` was also keeping `ORPHAN` alive — the prune only
 * removed a TAG, the image count didn't move, and not a single byte was
 * reclaimed. A disk assertion would then have measured nothing. `busybox` is
 * distinct and its only tag is `ORPHAN`, so its disappearance is total and
 * measurable.
 */
async function seedJunk(client: SshClient): Promise<void> {
  await docker(client, "rm", "-f", DEAD_CONTAINER, LIVE_CONTAINER);
  await docker(client, "volume", "rm", "-f", VOLUME);
  await docker(client, "pull", "alpine:3");
  await docker(client, "pull", "busybox:latest");

  await docker(client, "tag", "busybox:latest", ORPHAN);
  await docker(client, "image", "rm", "busybox:latest");
  await docker(client, "tag", "alpine:3", KEPT);

  await docker(client, "run", "--name", DEAD_CONTAINER, ORPHAN, "true");
  await docker(client, "run", "-d", "--name", LIVE_CONTAINER, KEPT, "sleep", "900");

  // A volume WITH content: "still listed" doesn't distinguish an intact
  // volume from one recreated empty.
  await docker(client, "volume", "create", VOLUME);
  await docker(
    client,
    "run",
    "--rm",
    "-v",
    `${VOLUME}:/data`,
    "alpine:3",
    "sh",
    "-c",
    `printf '%s' '${CANARY}' > /data/canary`,
  );
}

async function imageExists(client: SshClient, tag: string): Promise<boolean> {
  const res = await docker(client, "image", "inspect", tag);
  return res.code === 0;
}

/** The names of RUNNING containers, to compare before and after. */
async function runningContainers(client: SshClient): Promise<string[]> {
  const res = await docker(client, "ps", "--format", "{{.Names}}");
  return res.stdout.split("\n").filter(Boolean).sort();
}

async function networkNames(client: SshClient): Promise<string[]> {
  const res = await docker(client, "network", "ls", "--format", "{{.Name}}");
  return res.stdout.split("\n").filter(Boolean).sort();
}

const registry: RegistryConfig = {
  caCert: "unused",
  host: REGISTRY_HOST,
  password: "unused",
  username: "noddle",
};

await reset();

console.log(`\n\u001B[1mDocker prune — VM ${TARGET.host}\u001B[0m`);

let ssh: SshClient | undefined;

try {
  ssh = await connect({
    host: TARGET.host,
    port: 22,
    privateKey,
    user: TARGET.user,
  });
  await seedJunk(ssh);

  const beforeRunning = await runningContainers(ssh);
  const beforeNetworks = await networkNames(ssh);
  const beforeDf = (await dockerClient(ssh).df()) as {
    ImageUsage?: { TotalCount?: number; TotalSize?: number };
  };
  const beforeImageBytes = beforeDf.ImageUsage?.TotalSize ?? 0;
  const beforeImageCount = beforeDf.ImageUsage?.TotalCount ?? 0;

  const [server] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "prune-probe",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  const [dead] = await db
    .insert(servers)
    .values({
      host: DEAD,
      name: "prune-probe-mort",
      role: "worker",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!(server && dead)) {
    throw new Error("server insertion failed");
  }

  const [proj] = await db.insert(projects).values({ name: "prune" }).returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      buildMethod: "railpack",
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: "https://example.invalid/repo.git",
      name: "prune-probe",
      port: 3000,
      serverId: server.id,
      sourceType: "git",
    })
    .returning();
  if (!svc) {
    throw new Error("service insertion failed");
  }

  const seedDeployment = async (imageTag: string, imagePurged = false) => {
    const [row] = await db
      .insert(deployments)
      .values({
        imagePurged,
        imageTag,
        serviceId: svc.id,
        status: "succeeded",
        trigger: "manual",
      })
      .returning();
    if (!row) {
      throw new Error("deployment insertion failed");
    }
    return row.id;
  };

  const orphanDep = await seedDeployment(ORPHAN);
  const keptDep = await seedDeployment(KEPT);
  const portableDep = await seedDeployment(PORTABLE);
  const alreadyDep = await seedDeployment(VANISHED, true);

  const ctx = verifyCtx({ appKey, db, registry });

  const purgedOf = async (id: string): Promise<boolean> => {
    const row = await db.query.deployments.findFirst({
      where: eq(deployments.id, id),
    });
    return row?.imagePurged === true;
  };

  // ── 1. A missing node: we prune, we conclude NOTHING ─────────────────────
  //
  // The dead server is still in the database, so the table is incomplete.
  // The reachable machine is really pruned — this is where the fixture data
  // disappears — but no row is marked.
  const partial = await pruneDocker(ctx);

  if (partial.nodes.length === 1 && partial.skipped[0]?.serverId === dead.id) {
    ok("the reachable node is pruned, the dead node is flagged");
  } else {
    ko(
      `${partial.nodes.length} node(s) pruned, ${partial.skipped.length} skipped` +
        (partial.skipped[0] ? ` — ${partial.skipped[0].reason}` : ""),
    );
  }

  if (partial.reconciledFully === false && partial.reconciled.length === 0) {
    ok("a node without a response suspends the ENTIRE reconciliation");
  } else {
    ko(`reconciliation ran despite a silent node (${partial.reconciled.length} row(s))`);
  }

  // The assertion that gives the previous one meaning: the image is REALLY
  // gone, so marking it would have been correct — and we don't mark it,
  // because we couldn't look everywhere.
  if (await imageExists(ssh, ORPHAN)) {
    ko("the orphan image is still there: the prune did nothing");
  } else {
    ok("the image only a STOPPED container referenced is gone");
  }
  if (await purgedOf(orphanDep)) {
    ko("DANGER: row marked even though a node hadn't responded");
  } else {
    ok("the row whose image is nonetheless gone is NOT marked");
  }

  // ── 2. What the prune isn't allowed to touch ──────────────────────────────
  const deadGone = await docker(ssh, "inspect", DEAD_CONTAINER);
  if (deadGone.code === 0) {
    ko("the stopped container is still there");
  } else {
    ok("the stopped container was removed");
  }

  if (await imageExists(ssh, KEPT)) {
    ok("the image of a RUNNING container survives");
  } else {
    ko("DANGER: the image of a running container was deleted");
  }

  const afterRunning = await runningContainers(ssh);
  if (afterRunning.join("\n") === beforeRunning.join("\n")) {
    ok(`no running container moved (${afterRunning.length}, control plane included)`);
  } else {
    ko(`running containers changed: ${beforeRunning} → ${afterRunning}`);
  }

  const canary = await docker(
    ssh,
    "run",
    "--rm",
    "-v",
    `${VOLUME}:/data`,
    "alpine:3",
    "cat",
    "/data/canary",
  );
  if (canary.stdout === CANARY) {
    ok("the named volume and ITS CONTENT survive");
  } else {
    ko(`DANGER: volume lost or emptied (read "${canary.stdout}")`);
  }

  const afterNetworks = await networkNames(ssh);
  if (afterNetworks.join("\n") === beforeNetworks.join("\n")) {
    ok("no network was removed");
  } else {
    ko(`networks changed: ${beforeNetworks} → ${afterNetworks}`);
  }

  // ── 3. Bytes actually reclaimed, and the screen that sees it ─────────────
  //
  // "the prune ran" proves nothing: a prune without `-a` would reclaim
  // NOTHING on a Noddle node, for lack of a dangling image, and would look
  // exactly like it worked.
  const [node] = partial.nodes;
  if (node && node.bytesReclaimed > 0 && node.imagesDeleted > 0) {
    ok(
      `${node.imagesDeleted} image(s) removed, ${(node.bytesReclaimed / 1e6).toFixed(1)} MB reclaimed`,
    );
  } else {
    ko(`prune had no effect: ${JSON.stringify(node)}`);
  }

  // The prune must be VISIBLE on /servers/<id>, otherwise the screen claims
  // a full disk on a machine that was just emptied — for ten minutes, until
  // collection runs again.
  const disk = await db.query.serverDiskUsage.findFirst({
    where: eq(serverDiskUsage.serverId, server.id),
  });
  if (disk && disk.imageBytes < beforeImageBytes && disk.imageCount < beforeImageCount) {
    ok(
      `usage is recorded right after (${beforeImageCount} → ${disk.imageCount} images, ${(beforeImageBytes / 1e9).toFixed(2)} → ${(disk.imageBytes / 1e9).toFixed(2)} GB)`,
    );
  } else {
    ko(
      `no reading after the prune, or no decrease (${disk?.imageCount}/${disk?.imageBytes} vs ${beforeImageCount}/${beforeImageBytes})`,
    );
  }

  // ── 4. The complete table: reconciliation decides ─────────────────────────
  await db.delete(servers).where(eq(servers.id, dead.id));
  const full = await pruneDocker(ctx);

  if (full.reconciledFully) {
    ok("with all servers having responded, reconciliation runs");
  } else {
    ko("reconciliation still suspended even though the dead node is removed");
  }

  if (await purgedOf(orphanDep)) {
    ok("the row whose local image is gone is marked `image_purged`");
  } else {
    ko('the local image is gone and the row still offers "Redeploy"');
  }

  // Without this one, a reconciliation that marked EVERYTHING would be green.
  if (await purgedOf(keptDep)) {
    ko("DANGER: row marked even though its image is still there");
  } else {
    ok("the row whose image is still present isn't marked");
  }

  // The truth is PER-NODE: a registry image isn't absent just because one
  // node no longer has it cached. It's `registry-sweep` that decides that.
  if (await purgedOf(portableDep)) {
    ko("DANGER: REGISTRY image marked based on a local absence");
  } else {
    ok("a registry image absent locally is NOT marked");
  }

  if (
    (await purgedOf(alreadyDep)) &&
    !full.reconciled.includes(alreadyDep) &&
    full.reconciled.length === 1
  ) {
    ok("a row already marked stays marked and isn't recounted");
  } else {
    ko(`recount: ${JSON.stringify(full.reconciled)}`);
  }

  // ── 5. A CLEAN machine still comes back with a reading ────────────────────
  //
  // This second pass just re-pruned an already-pruned machine: its images
  // and containers therefore have nothing left to reclaim, and Docker
  // serializes these aggregates with `omitempty` — the `Reclaimable` field
  // DISAPPEARS from the response. `parseDiskUsage` read that as "unknown"
  // and wrote no row: the screen for a perfectly clean machine said "no
  // reading", i.e. the message that announces it couldn't be reached. The
  // defect predates this change — it wasn't visible as long as the VM still
  // had leftovers — and it's the prune that turns that into the normal state.
  const clean = await db.query.serverDiskUsage.findMany({
    where: eq(serverDiskUsage.serverId, server.id),
  });
  const latest = clean.at(-1);
  if (clean.length === 2 && latest && latest.imageReclaimableBytes === 0) {
    ok("a machine with nothing to reclaim still produces a reading");
  } else {
    ko(`${clean.length} reading(s), reclaimable images = ${latest?.imageReclaimableBytes}`);
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 4).join("\n"));
  }
} finally {
  if (ssh) {
    await docker(ssh, "rm", "-f", LIVE_CONTAINER, DEAD_CONTAINER);
    await docker(ssh, "volume", "rm", "-f", VOLUME);
    await docker(ssh, "image", "rm", "-f", KEPT, ORPHAN);
    disconnect(ssh);
  }
  await reset();
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
