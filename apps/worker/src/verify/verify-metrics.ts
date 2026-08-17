// tier: vm
// node apps/worker/src/verify/verify-metrics.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "@noddle/db";
import {
  databases,
  environments,
  projects,
  serverDiskUsage,
  serverMetrics,
  servers,
  serviceMetrics,
  services,
} from "@noddle/db/schema";
import { connect, disconnect, exec } from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { collectMetrics, cpuPercent, parseDiskUsage, parseHostFacts } from "#metrics";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();
const DEAD = "192.0.2.1"; // TEST-NET-1: guaranteed non-routable

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
const sshKeyId = await seedSshKey(db, appKey, "verify-metrics", privateKey);

const HUMAN_SIZE = /^([\d.]+)\s*([kMGTP]?B)$/;

/**
 * Size as the CLI writes it, re-read as bytes.
 *
 * **DECIMAL — and that is the point of this bench.** Docker's
 * `units.HumanSize` divides by 1000, not 1024 — hence "GB" not "GiB". Measured
 * side by side on the VM: the API says 3 574 994 286, the CLI says "3.575GB".
 * Reading that as 1024³ would yield 3 838 627 021, i.e. 7.4 % too high.
 *
 * This function exists only for the test: the product never re-reads a
 * formatted string; it takes the API integers.
 */
function humanToBytes(size: string): number {
  const match = HUMAN_SIZE.exec(size.trim());
  if (!match) {
    return Number.NaN;
  }
  const scale: Record<string, number> = {
    B: 1,
    GB: 1e9,
    MB: 1e6,
    PB: 1e15,
    TB: 1e12,
    kB: 1e3,
  };
  return Number.parseFloat(match[1] as string) * (scale[match[2] as string] ?? 1);
}

/**
 * Cleanup.
 *
 * `databases.serverId` and `services.serverId` are `restrict`, not `cascade` —
 * deleting a machine that still holds data must be refused. The bench must
 * therefore remove dependents ITSELF, which the first run learned the hard
 * way: it hit a database left by a previous verification.
 */
async function reset(): Promise<void> {
  await db.delete(serviceMetrics);
  await db.delete(serverMetrics);
  await db.delete(serverDiskUsage);
  const probes = await db.query.servers.findMany({
    where: inArray(servers.host, [TARGET.host, DEAD]),
  });
  for (const s of probes) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup by design
    await db.delete(databases).where(eq(databases.serverId, s.id));
    await db.delete(services).where(eq(services.serverId, s.id));
  }
  await db.delete(servers).where(inArray(servers.host, [TARGET.host, DEAD]));
  await db.delete(projects).where(eq(projects.name, "metrics-probe"));
}

await reset();

console.log(`\n\u001B[1mResource collection — VM ${TARGET.host}\u001B[0m`);

try {
  // ── 1. Parsing, no network ──────────────────────────────────────────────
  const parsed = parseHostFacts("0.14 2 2002136 1587628 19682557952 7499407360");
  if (
    parsed &&
    parsed.cpuCount === 2 &&
    parsed.memoryTotalBytes === 2_002_136 * 1024 &&
    parsed.memoryUsedBytes === (2_002_136 - 1_587_628) * 1024
  ) {
    ok("parseHostFacts reads the real output measured on the VM");
  } else {
    ko(`parseHostFacts: ${JSON.stringify(parsed)}`);
  }

  // A truncated output must be REFUSED, not padded with zeros.
  if (parseHostFacts("0.14 2 2002136") === null) {
    ok("a truncated output is refused rather than padded with zeros");
  } else {
    ko("a truncated output produced a sample");
  }

  // A container that just started has no system delta: we do not know, so we
  // do not record. Zero would be a lie readable as "idle".
  if (
    cpuPercent({
      cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 100 },
    }) === null
  ) {
    ok("a zero system delta yields nothing at all, not 0 %");
  } else {
    ko("a zero system delta produced a percentage");
  }

  // `/system/df` aggregates date from API 1.52 (Docker 29) — measured,
  // `/v1.51/system/df` only returns raw lists. On an older daemon it must
  // emit NOTHING: a machine whose images weighed nothing would read as an
  // empty machine, the exact counter-sense the hole rule exists to avoid,
  // and the only place in the product where it could go unnoticed since
  // nobody knows their VM disk by heart.
  if (
    parseDiskUsage({
      ContainerUsage: { Reclaimable: 0, TotalCount: 1, TotalSize: 1 },
      ImageUsage: { Reclaimable: 0, TotalCount: 1, TotalSize: 1 },
      VolumeUsage: { Reclaimable: 0, TotalCount: 1, TotalSize: 1 },
    }) === null
  ) {
    ok("a daemon without API 1.52 aggregates produces NO row");
  } else {
    ko("a missing aggregate still produced a sample");
  }

  // ── 2. A real collection ────────────────────────────────────────────────
  const [server] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "metrics-probe",
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

  const first = await collectMetrics(ctx);
  if (first.servers === 1 && first.skipped.length === 0) {
    ok("the reachable server is sampled");
  } else {
    ko(`collection: ${JSON.stringify(first)}`);
  }

  const [sample] = await db.query.serverMetrics.findMany({
    where: eq(serverMetrics.serverId, server.id),
  });
  if (!sample) {
    throw new Error("no sample written");
  }

  // Values must be COHERENT, not merely present.
  const coherent =
    sample.memoryUsedBytes > 0 &&
    sample.memoryUsedBytes < sample.memoryTotalBytes &&
    sample.diskUsedBytes > 0 &&
    sample.diskUsedBytes < sample.diskTotalBytes &&
    sample.cpuCount >= 1 &&
    sample.cpuLoad1 >= 0;
  if (coherent) {
    const memPct = Math.round((sample.memoryUsedBytes / sample.memoryTotalBytes) * 100);
    const diskPct = Math.round((sample.diskUsedBytes / sample.diskTotalBytes) * 100);
    ok(
      `coherent values: ${sample.cpuCount} cores, load ${sample.cpuLoad1}, mem ${memPct} %, disk ${diskPct} %`,
    );
  } else {
    ko(`incoherent values: ${JSON.stringify(sample)}`);
  }

  // The VM is provisioned at 2 GB: if we read the DEV MACHINE's memory
  // instead of the target's, this test would catch it.
  const totalMb = Math.round(sample.memoryTotalBytes / 1024 / 1024);
  if (totalMb > 1500 && totalMb < 2500) {
    ok(`measured memory is the VM's (${totalMb} MB), not the host's`);
  } else {
    ko(`measured memory ${totalMb} MB — is this really the target?`);
  }

  // ── 2 bis. Disk breakdown ───────────────────────────────────────────────
  //
  // "a row was written" proves nothing: it would also be written with wrong
  // bytes. So we confront the stored figures — which come from API aggregates
  // — with what the CLI shows a human on the SAME machine, read over a second
  // SSH connection. The two must agree, and that fixes the measured fact:
  // `docker system df` formats sizes in DECIMAL. Reading them as 1024³ — a
  // common mistake — would overestimate by 7.4 % — enough for this assertion
  // to fail.
  const [disk] = await db.query.serverDiskUsage.findMany({
    where: eq(serverDiskUsage.serverId, server.id),
  });
  if (!disk) {
    throw new Error("no disk breakdown written");
  }

  const cli = await connect({
    host: TARGET.host,
    privateKey,
    user: TARGET.user,
  });
  let cliOut = "";
  try {
    cliOut = (await exec(cli, "docker system df --format '{{json .}}'")).stdout;
  } finally {
    disconnect(cli);
  }
  const cliBytes = new Map<string, number>();
  for (const line of cliOut.trim().split("\n")) {
    const row = JSON.parse(line) as { Size: string; Type: string };
    cliBytes.set(row.Type, humanToBytes(row.Size));
  }

  const pairs: [string, number, number][] = [
    ["Images", disk.imageBytes, cliBytes.get("Images") ?? Number.NaN],
    ["Containers", disk.containerBytes, cliBytes.get("Containers") ?? Number.NaN],
    ["Volumes", disk.volumeBytes, cliBytes.get("Local Volumes") ?? Number.NaN],
    ["Build Cache", disk.buildCacheBytes, cliBytes.get("Build Cache") ?? Number.NaN],
  ];
  // 1 %: the CLI rounds to four significant digits, no more.
  const drift = pairs.map(([, stored, shown]) => Math.abs(stored - shown) / Math.max(shown, 1));
  if (drift.every((d) => d < 0.01)) {
    ok(`stored bytes agree with the CLI (max drift ${(Math.max(...drift) * 100).toFixed(2)} %)`);
  } else {
    ko(`CLI/API divergence: ${pairs.map(([n, s, c]) => `${n} ${s}≠${c}`).join(", ")}`);
  }

  // Reclaimable is a SEPARATE fact from size: conflating them would promise
  // to free disk that is still referenced.
  if (
    disk.imageReclaimableBytes >= 0 &&
    disk.imageReclaimableBytes <= disk.imageBytes &&
    disk.imageCount > 0
  ) {
    ok(
      `reclaimable bounded by size: ${disk.imageCount} images, ${disk.imageReclaimableBytes} / ${disk.imageBytes} B`,
    );
  } else {
    ko(`incoherent reclaimable: ${JSON.stringify(disk)}`);
  }

  // Cadence, BOTH WAYS. Testing only the refusal would let through a sampler
  // that NEVER samples — as wrong as one that samples every minute, and
  // invisible on a screen that shows "no reading".
  const repeat = await collectMetrics(ctx);
  const afterRepeat = await db.query.serverDiskUsage.findMany({
    where: eq(serverDiskUsage.serverId, server.id),
  });
  if (afterRepeat.length === 1 && repeat.disks === 0) {
    ok("a second immediate pass does NOT resample the disk");
  } else {
    ko(`${afterRepeat.length} disk row(s) after two passes`);
  }

  // Wound back past the interval: sampling is due again.
  await db
    .update(serverDiskUsage)
    .set({ sampledAt: new Date(Date.now() - 11 * 60 * 1000) })
    .where(eq(serverDiskUsage.id, disk.id));
  const due = await collectMetrics(ctx);
  const afterDue = await db.query.serverDiskUsage.findMany({
    where: eq(serverDiskUsage.serverId, server.id),
  });
  if (afterDue.length === 2 && due.disks === 1) {
    ok("past the interval, the disk is resampled");
  } else {
    ko(`${afterDue.length} disk row(s) after interval expiry`);
  }

  // ── 3. An unreachable server: a HOLE, not a zero ────────────────────────
  const [dead] = await db
    .insert(servers)
    .values({
      host: DEAD,
      name: "metrics-probe-dead",
      role: "worker",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!dead) {
    throw new Error("dead server insert failed");
  }

  const second = await collectMetrics(ctx);
  const deadRows = await db.query.serverMetrics.findMany({
    where: eq(serverMetrics.serverId, dead.id),
  });
  const deadDisk = await db.query.serverDiskUsage.findMany({
    where: eq(serverDiskUsage.serverId, dead.id),
  });
  if (deadRows.length === 0) {
    ok("an unreachable server writes NO row — the hole stays a hole");
  } else {
    ko(`DANGER: ${deadRows.length} row(s) written for a dead server`);
  }
  // Same rule for disk, and it is worth testing separately: a machine whose
  // breakdown was all zeros would read as "nothing on it", the exact opposite
  // of "we do not know".
  if (deadDisk.length === 0) {
    ok("an unreachable server writes no disk breakdown either");
  } else {
    ko(`DANGER: ${deadDisk.length} breakdown(s) for a dead server`);
  }
  if (second.skipped.includes(dead.id)) {
    ok("the skipped server is reported as such");
  } else {
    ko("the unreachable server is not flagged");
  }
  if (second.servers === 1) {
    ok("one server's failure does not prevent sampling the other");
  } else {
    ko(`${second.servers} server(s) sampled, expected 1`);
  }
  // ── 6. Databases are sampled like services ──────────────────────────────
  //
  // A DISPOSABLE Swarm service rather than a real provisioned database: what
  // this bench exercises is the chain `databases.status='running'` → Swarm
  // name → container present on this node → `docker stats`, and that chain
  // knows nothing about the engine running inside. Provisioning Postgres
  // would cost minutes and 300 MB on a 2 048 MB VM — `verify-database.ts`
  // already proves provisioning; no need to redo it here.
  const probeName = `ndb-metrics-${randomBytes(4).toString("hex")}`;
  const managerSsh = await connect({
    host: TARGET.host,
    privateKey,
    user: TARGET.user,
  });
  // PINNED to the manager, as a real database is (its volume only exists on
  // its node). Without a constraint, Swarm places wherever it wants:
  // measured, the first attempt landed on the OTHER VM, so the container was
  // not on the sampled node and the bench reported 0 databases — a red that
  // blamed the code when the fault was staging.
  await exec(
    managerSsh,
    `docker service create --detach --name ${probeName} --constraint node.role==manager --restart-condition any alpine:3 sleep 3600`,
  );
  // The container only exists when the task STARTS, not when the command
  // returns — the same trap as stack volumes, where grepping 3 seconds too
  // early concluded "no prefix" instead of "nothing yet".
  let probeUp = false;
  for (let i = 0; i < 60 && !probeUp; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: polling, sequential by nature
    const seen = await exec(
      managerSsh,
      `docker ps -q --filter label=com.docker.swarm.service.name=${probeName}`,
    );
    probeUp = seen.stdout.trim().length > 0;
    if (!probeUp) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // SETUP fails loudly. Without that, a container that never started yields
  // "0 databases sampled" — a red that blames the code — and makes the
  // "a stopped database is spared" assertion green for free, since nothing
  // would have been sampled anyway.
  if (!probeUp) {
    throw new Error(`probe container ${probeName} never appeared`);
  }

  const [proj] = await db.insert(projects).values({ name: "metrics-probe" }).returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  const common = {
    engine: "postgres" as const,
    environmentId: env?.id ?? "",
    rootPasswordEncrypted: "v1.none",
    serverId: server.id,
  };
  const [liveDb] = await db
    .insert(databases)
    .values({
      ...common,
      name: "metrics-live",
      status: "running",
      swarmName: probeName,
    })
    .returning();
  // SAME Swarm name, so the same container is there: only STATUS separates
  // them. That is what makes the "spared" assertion conclusive — otherwise
  // we would not know if it was spared or simply not found.
  const [stoppedDb] = await db
    .insert(databases)
    .values({
      ...common,
      name: "metrics-stopped",
      status: "stopped",
      swarmName: probeName,
    })
    .returning();

  const third = await collectMetrics(ctx);
  if (third.databases === 1) {
    ok("a running database is sampled");
  } else {
    ko(`${third.databases} database(s) sampled, expected 1`);
  }

  const dbRows = await db.query.serviceMetrics.findMany({
    where: eq(serviceMetrics.databaseId, liveDb?.id ?? ""),
  });
  const [dbRow] = dbRows;
  if (dbRow && dbRow.serviceId === null && dbRows.length === 1) {
    ok("the row carries `database_id` and leaves `service_id` NULL");
  } else {
    ko(`incoherent database row: ${JSON.stringify(dbRows)}`);
  }
  // The row could carry the right owner and measure the wrong container: the
  // task name is what decides.
  if (dbRow?.taskName.startsWith(probeName)) {
    ok(`the measured container is the database's (${dbRow.taskName})`);
  } else {
    ko(`measured task: ${dbRow?.taskName ?? "none"}, expected ${probeName}*`);
  }
  if (dbRow && dbRow.memoryUsedBytes > 0) {
    ok(`measured memory is real (${dbRow.memoryUsedBytes} bytes)`);
  } else {
    ko(`measured memory: ${dbRow?.memoryUsedBytes ?? "none"}`);
  }

  const stoppedRows = await db.query.serviceMetrics.findMany({
    where: eq(serviceMetrics.databaseId, stoppedDb?.id ?? ""),
  });
  if (stoppedRows.length === 0) {
    ok("a stopped database is SPARED, even though its container is there");
  } else {
    ko(`${stoppedRows.length} row(s) for a stopped database`);
  }

  // ── 7. The constraint refuses a row without a clear owner ───────────────
  //
  // Without it, a row with both keys null would survive BOTH cascades and
  // belong to nothing — invisible from either side, eternal.
  const orphan = {
    blockReadBytes: 0,
    blockWriteBytes: 0,
    cpuPercent: 1,
    memoryLimitBytes: 0,
    memoryUsedBytes: 1,
    networkInBytes: 0,
    networkOutBytes: 0,
  };
  let refusedBoth = false;
  try {
    await db.insert(serviceMetrics).values({
      ...orphan,
      databaseId: liveDb?.id ?? "",
      serviceId: null,
      taskName: "x",
    });
    // this one MUST pass: a single owner
    await db.delete(serviceMetrics).where(eq(serviceMetrics.taskName, "x"));
  } catch {
    ko("a row with ONE owner was refused");
  }
  try {
    await db
      .insert(serviceMetrics)
      .values({ ...orphan, databaseId: null, serviceId: null, taskName: "y" });
  } catch {
    refusedBoth = true;
  }
  if (refusedBoth) {
    ok("a row with NO owner is refused by the constraint");
  } else {
    ko("DANGER: an orphan row was accepted");
  }

  await exec(managerSsh, `docker service rm ${probeName}`);
  disconnect(managerSsh);
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 4).join("\n"));
  }
} finally {
  await reset();
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
