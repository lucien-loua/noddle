// tier: vm
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  servers,
  serviceDomains,
  services,
} from "@noddle/db/schema";
import {
  pushImage,
  REGISTRY_USER,
  registryImageTag,
} from "@noddle/deploy-engine";
import type { RegistryConfig } from "@noddle/deploy-engine";
import {
  ensureRegistryTrust,
  KEEP_PER_SERVICE,
  removeService,
} from "@noddle/deploy-engine/ops";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
  quoteArg,
} from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { redeployImage, runDeploy } from "#deploy";
import { provisionServer } from "#provision";
import { sweepRegistry } from "#registry-sweep";
import { runServiceTeardown } from "#teardown";
import { seedSshKey, verifyCtx } from "#verify-seed";

const MANAGER = devTarget();
const WORKER = devTarget("noddle-target-2");

const execFileAsync = promisify(execFile);

const DB_URL = devStack().databaseUrl;

const SERVICE_NAME = "noddle-reg";
const ORIGIN = "/opt/noddle-reg-origin";
const CERT_DIR = "/etc/noddle/registry";
const REGISTRY_CONTAINER = "noddle-registry";
const FIRST_FIELD = /\s/;

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
const step = (m: string) => console.log(`\n\u001B[1m${m}\u001B[0m`);

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const { privateKey } = MANAGER;
const sshKeyId = await seedSshKey(db, appKey, "verify-registry", privateKey);
const registryPassword = randomBytes(16).toString("hex");
const domain = `${SERVICE_NAME}.${MANAGER.host.replaceAll(".", "-")}.sslip.io`;

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;
let workerSsh: Awaited<ReturnType<typeof connect>> | undefined;

async function dockerStartedAt(
  client: Awaited<ReturnType<typeof connect>>
): Promise<string> {
  const res = await exec(
    client,
    "systemctl show docker --property=ActiveEnterTimestamp --value"
  );
  return res.stdout.trim();
}

await db.delete(deployments);
await db.delete(services);
await db.delete(environments);
await db.delete(projects);
await db
  .delete(servers)
  .where(inArray(servers.host, [MANAGER.host, WORKER.host]));

try {
  managerSsh = await connect({
    host: MANAGER.host,
    privateKey,
    user: MANAGER.user,
  });
  const managerDocker = dockerClient(managerSsh);

  step("Registry on the manager");
  await exec(managerSsh, `sudo docker rm -f ${REGISTRY_CONTAINER}`);
  await exec(
    managerSsh,
    `sudo rm -rf ${CERT_DIR} && sudo mkdir -p ${CERT_DIR} && ` +
      "sudo openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes " +
      `-keyout ${CERT_DIR}/ca.key -out ${CERT_DIR}/ca.crt ` +
      `-subj '/CN=Noddle Registry CA' ` +
      `-addext 'basicConstraints=critical,CA:TRUE' ` +
      `-addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null && ` +
      `printf 'subjectAltName=IP:${MANAGER.host}\\nbasicConstraints=CA:FALSE\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\n' | sudo tee ${CERT_DIR}/ext.cnf >/dev/null && ` +
      `sudo openssl req -newkey rsa:2048 -nodes -keyout ${CERT_DIR}/registry.key ` +
      `-out ${CERT_DIR}/registry.csr -subj '/CN=${MANAGER.host}' 2>/dev/null && ` +
      `sudo openssl x509 -req -in ${CERT_DIR}/registry.csr -CA ${CERT_DIR}/ca.crt ` +
      `-CAkey ${CERT_DIR}/ca.key -CAcreateserial -out ${CERT_DIR}/registry.crt ` +
      `-days 3650 -sha256 -extfile ${CERT_DIR}/ext.cnf 2>/dev/null`
  );
  const htpasswd = await exec(
    managerSsh,
    `printf '%s' ${quoteArg(registryPassword)} | sudo docker run --rm -i httpd:2-alpine htpasswd -Bin noddle 2>/dev/null | sudo tee ${CERT_DIR}/htpasswd`
  );
  if (htpasswd.stdout.includes("$2y$")) {
    ok("CA, certificate, and bcrypt htpasswd generated");
  } else {
    ko(`unexpected htpasswd: ${htpasswd.stdout.slice(0, 60)}`);
  }

  await execArgv(managerSsh, [
    "sudo",
    "docker",
    "run",
    "-d",
    "--name",
    REGISTRY_CONTAINER,
    "--restart",
    "unless-stopped",
    "-p",
    "5000:5000",
    "-v",
    `${CERT_DIR}:/certs:ro`,
    "-e",
    "REGISTRY_HTTP_ADDR=0.0.0.0:5000",
    "-e",
    "REGISTRY_HTTP_TLS_CERTIFICATE=/certs/registry.crt",
    "-e",
    "REGISTRY_HTTP_TLS_KEY=/certs/registry.key",
    "-e",
    "REGISTRY_AUTH=htpasswd",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_REALM=noddle",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_PATH=/certs/htpasswd",
    "-e",
    "REGISTRY_STORAGE_DELETE_ENABLED=true",
    "registry:3.1.1",
  ]);
  await sleep(4000);
  const alive = await exec(
    managerSsh,
    `sudo docker inspect -f '{{.State.Running}}' ${REGISTRY_CONTAINER}`
  );
  if (alive.stdout.trim() === "true") {
    ok("registry:3.1.1 started in TLS + auth");
  } else {
    const why = await exec(
      managerSsh,
      `sudo docker logs --tail 5 ${REGISTRY_CONTAINER}`
    );
    ko(`registry dead: ${why.stderr.trim() || why.stdout.trim()}`);
    throw new Error("registry unavailable, the rest makes no sense");
  }

  const caCert = (
    await exec(managerSsh, `sudo cat ${CERT_DIR}/ca.crt`)
  ).stdout.trim();
  const registry: RegistryConfig = {
    caCert,
    host: `${MANAGER.host}:5000`,
    password: registryPassword,
    username: REGISTRY_USER,
  };

  step("Trust without restarting the daemon");
  const startedBefore = await dockerStartedAt(managerSsh);

  await exec(managerSsh, "sudo rm -rf /etc/docker/certs.d");
  await exec(managerSsh, "sudo docker pull -q alpine:3");
  await exec(
    managerSsh,
    `sudo docker tag alpine:3 ${registry.host}/probe-nocert:v1`
  );
  const beforeTrust = await pushImage(managerSsh, registry, {
    imageTag: `${registry.host}/probe-nocert:v1`,
  }).then(
    () => null,
    (error: Error) => error.message
  );
  if (beforeTrust?.includes("x509") || beforeTrust?.includes("certificate")) {
    ok("without the CA: push refused, and the error NAMES the certificate");
  } else {
    ko(`without the CA, unexpected error: ${beforeTrust ?? "no error!"}`);
  }

  const wrote = await ensureRegistryTrust(managerSsh, registry);
  const rewrote = await ensureRegistryTrust(managerSsh, registry);
  if (wrote && !rewrote) {
    ok("CA written, then replayed without rewriting (idempotent)");
  } else {
    ko(`CA deposit: written=${wrote}, rewritten=${rewrote}`);
  }

  await pushImage(managerSsh, registry, {
    imageTag: `${registry.host}/probe-nocert:v1`,
  });
  const startedAfter = await dockerStartedAt(managerSsh);
  if (startedBefore === startedAfter && startedBefore !== "") {
    ok(`push accepted WITHOUT restarting the daemon (started ${startedAfter})`);
  } else {
    ko(`the daemon restarted: ${startedBefore} → ${startedAfter}`);
  }

  step("Servers");
  const [managerRow] = await db
    .insert(servers)
    .values({
      host: MANAGER.host,
      name: "reg-manager",
      role: "manager",
      sshKeyId,
      sshUser: MANAGER.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!managerRow) {
    throw new Error("manager insertion failed");
  }

  const [workerRow] = await db
    .insert(servers)
    .values({
      host: WORKER.host,
      name: "reg-worker",
      sshKeyId,
      sshUser: MANAGER.user,
    })
    .returning();
  if (!workerRow) {
    throw new Error("worker insertion failed");
  }

  const ctx = verifyCtx({ appKey, db, registry });
  const route = { networkName: "noddle-public" };
  const build = { logRoot: "/tmp/noddle-reg-logs" };

  console.log("    (provisioning the worker: Docker, join, CA…)");
  await provisionServer(ctx, workerRow.id);

  const provisioned = await db.query.servers.findFirst({
    where: eq(servers.id, workerRow.id),
  });
  if (provisioned?.status === "connected" && provisioned.swarmNodeId) {
    ok(
      `worker provisioned, Swarm node ${provisioned.swarmNodeId.slice(0, 12)}`
    );
  } else {
    ko(
      `provisioning: ${provisioned?.status}, node ${provisioned?.swarmNodeId ?? "—"}, ${provisioned?.lastError ?? ""}`
    );
  }

  workerSsh = await connect({
    host: WORKER.host,
    privateKey,
    user: MANAGER.user,
  });
  const caOnWorker = await exec(
    workerSsh,
    `sudo cat /etc/docker/certs.d/${registry.host}/ca.crt`
  );
  if (
    caOnWorker.code === 0 &&
    caOnWorker.stdout.includes("BEGIN CERTIFICATE")
  ) {
    ok("the CA reached the worker, via provisioning");
  } else {
    ko("the CA isn't on the worker");
  }

  step("Deployment: built on the worker, pushed, not pinned");
  await exec(
    workerSsh,
    `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
      `cd ${quoteArg(ORIGIN)} && ` +
      `printf '%s' '{"name":"reg","scripts":{"start":"node s.js"}}' > package.json && ` +
      `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("registre bonjour")).listen(p)' > s.js && ` +
      "git init -q -b main . && git config user.email e@x && git config user.name e && " +
      "git add -A && git commit -q -m init"
  );

  const leftovers = await managerDocker.listServices({
    filters: JSON.stringify({ name: [SERVICE_NAME] }),
  });
  for (const old of leftovers) {
    const name = old.Spec?.Name;
    if (name?.startsWith(`${SERVICE_NAME}-`) || name === SERVICE_NAME) {
      await removeService(managerDocker, name);
    }
  }

  const [proj] = await db.insert(projects).values({ name: "reg" }).returning();
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
      gitRepoUrl: `file://${ORIGIN}`,
      name: SERVICE_NAME,
      port: 3000,
      serverId: workerRow.id,
      sourceType: "git",
    })
    .returning();
  if (!svc) {
    throw new Error("service insertion failed");
  }
  await db.insert(serviceDomains).values({ host: domain, serviceId: svc.id });
  const swarmName = swarmServiceName(svc);

  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep) {
    throw new Error("deployment insertion failed");
  }

  console.log("    (railpack build on the worker, push, Swarm switch…)");
  await runDeploy(ctx, route, build, { deploymentId: dep.id });

  const final = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep.id),
  });
  if (final?.status === "succeeded") {
    ok(`deployment succeeded — ${final.imageTag}`);
  } else {
    ko(`status ${final?.status} — ${final?.errorMessage ?? ""}`);
    throw new Error("deployment failed, the rest makes no sense");
  }

  if (final.imageTag?.startsWith(`${registry.host}/`)) {
    ok("the tag carries the registry host");
  } else {
    ko(`unqualified tag: ${final.imageTag}`);
  }

  const catalog = await exec(
    managerSsh,
    `curl -sS --cacert /etc/docker/certs.d/${registry.host}/ca.crt ` +
      `-u noddle:${quoteArg(registryPassword)} https://${registry.host}/v2/_catalog`
  );
  if (catalog.stdout.includes(swarmName)) {
    ok(`the registry exposes the repository: ${catalog.stdout.trim()}`);
  } else {
    ko(`repository missing from the catalog: ${catalog.stdout.trim()}`);
  }

  await exec(
    managerSsh,
    `sudo docker tag alpine:3 ${registry.host}/rm-probe:v1`
  );
  await pushImage(managerSsh, registry, {
    imageTag: `${registry.host}/rm-probe:v1`,
    removeLocal: true,
  });
  const localAfter = await execArgv(managerSsh, [
    "sudo",
    "docker",
    "images",
    "-q",
    `${registry.host}/rm-probe:v1`,
  ]);
  if (localAfter.stdout.trim() === "") {
    ok("`removeLocal` does remove the local copy after a successful push");
  } else {
    ko("the local copy lingers after a push with removeLocal");
  }

  const specOf = async (): Promise<{
    constraints: string[];
    image: string;
  }> => {
    const list = (await managerDocker.listServices({
      filters: JSON.stringify({ name: [swarmName] }),
    })) as unknown as {
      Spec?: {
        Name?: string;
        TaskTemplate?: {
          ContainerSpec?: { Image?: string };
          Placement?: { Constraints?: string[] };
        };
      };
    }[];
    const found = list.find((s) => s.Spec?.Name === swarmName);
    return {
      constraints: found?.Spec?.TaskTemplate?.Placement?.Constraints ?? [],
      image: found?.Spec?.TaskTemplate?.ContainerSpec?.Image ?? "",
    };
  };

  const portableSpec = await specOf();
  if (portableSpec.constraints.length === 0) {
    ok("the service has NO placement constraint");
  } else {
    ko(`unexpected constraint: ${portableSpec.constraints.join(", ")}`);
  }

  if (final.nodeId) {
    ok(`the execution node is recorded: ${final.nodeId.slice(0, 12)}`);
  } else {
    ko("node_id not recorded");
  }

  const httpCheck = async (label: string): Promise<boolean> => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const res = await execFileAsync(
        "curl",
        [
          "-fsS",
          "--max-time",
          "10",
          "-H",
          `Host: ${domain}`,
          `http://${MANAGER.host}/`,
        ],
        { timeout: 12_000 }
      ).catch(() => null);
      if (res?.stdout.includes("registre")) {
        ok(`${label}: "${res.stdout.trim()}"`);
        return true;
      }
      await sleep(3000);
    }
    ko(`${label}: no response within 120s`);
    return false;
  };
  await httpCheck("HTTP through the overlay");

  step("Portability: draining the node that built the image");
  const workerNodeId = provisioned?.swarmNodeId ?? "";
  await execArgv(managerSsh, [
    "sudo",
    "docker",
    "node",
    "update",
    "--availability",
    "drain",
    workerNodeId,
  ]);

  let movedTo = "";
  const moveDeadline = Date.now() + 180_000;
  while (Date.now() < moveDeadline) {
    const tasks = (await managerDocker.listTasks({
      filters: JSON.stringify({ service: [swarmName] }),
    })) as unknown as {
      NodeID?: string;
      Status?: { State?: string };
    }[];
    const running = tasks.find((t) => t.Status?.State === "running");
    if (running?.NodeID && running.NodeID !== workerNodeId) {
      movedTo = running.NodeID;
      break;
    }
    await sleep(4000);
  }

  if (movedTo) {
    ok(
      `the task was RESCHEDULED onto ${movedTo.slice(0, 12)} — a node that never built this image`
    );
  } else {
    ko("the task wasn't rescheduled within 180s");
  }

  await httpCheck("HTTP from the node that PULLED the image");

  await execArgv(managerSsh, [
    "sudo",
    "docker",
    "node",
    "update",
    "--availability",
    "active",
    workerNodeId,
  ]);

  step("Rollback");
  if (final.imageTag) {
    await redeployImage(ctx, route, {
      imageTag: final.imageTag,
      serviceId: svc.id,
      trigger: "rollback",
    });
    const after = await db.query.deployments.findFirst({
      orderBy: (d, { desc }) => desc(d.createdAt),
      where: eq(deployments.serviceId, svc.id),
    });
    if (after?.status === "succeeded") {
      ok("rollback to a registry image accepted");
    } else {
      ko(`rollback: ${after?.status} — ${after?.errorMessage ?? ""}`);
    }
  }

  step("Migration: rollback to a pre-registry image");
  const legacyTag = `${SERVICE_NAME}:legacy-${Date.now()}`;
  await exec(
    workerSsh,
    `cd ${quoteArg(ORIGIN)} && sudo docker build -q -t ${quoteArg(legacyTag)} ` +
      "-f - . <<'DOCKERFILE'\n" +
      "FROM node:24-slim\nRUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*\n" +
      'WORKDIR /app\nCOPY . .\nCMD ["node","s.js"]\nDOCKERFILE'
  );
  const legacyBuilt = await execArgv(workerSsh, [
    "sudo",
    "docker",
    "images",
    "-q",
    legacyTag,
  ]);
  if (legacyBuilt.stdout.trim()) {
    ok('"legacy" image built locally on the worker, not pushed');
  } else {
    ko("building the legacy image failed");
  }

  await redeployImage(ctx, route, {
    imageTag: legacyTag,
    serviceId: svc.id,
    trigger: "rollback",
  });

  const legacySpec = await specOf();
  if (legacySpec.constraints.some((c) => c === `node.id==${workerNodeId}`)) {
    ok(
      "an image that was NOT pushed stays pinned to its node — the migration breaks nothing"
    );
  } else {
    ko(
      `legacy image without constraint: [${legacySpec.constraints.join(", ")}] — a rollback would head to a node without the image`
    );
  }

  const legacyDep = await db.query.deployments.findFirst({
    orderBy: (d, { desc }) => desc(d.createdAt),
    where: eq(deployments.serviceId, svc.id),
  });
  if (legacyDep?.status === "succeeded") {
    ok("and the legacy rollback still converges");
  } else {
    ko(`legacy rollback: ${legacyDep?.status} — ${legacyDep?.errorMessage}`);
  }

  step("Local image on a service hosted by the manager");
  const managerNodeId = (
    await exec(managerSsh, "sudo docker info --format '{{.Swarm.NodeID}}'")
  ).stdout.trim();

  await exec(
    managerSsh,
    `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
      `cd ${quoteArg(ORIGIN)} && ` +
      `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("registre bonjour")).listen(p)' > s.js && ` +
      'printf \'FROM node:24-slim\\nRUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*\\nWORKDIR /app\\nCOPY . .\\nCMD ["node","s.js"]\\n\' > Dockerfile && ' +
      `sudo docker build -q -t ${quoteArg(`${SERVICE_NAME}:mgr-local`)} .`
  );
  await db
    .update(services)
    .set({ serverId: managerRow.id })
    .where(eq(services.id, svc.id));

  await redeployImage(ctx, route, {
    imageTag: `${SERVICE_NAME}:mgr-local`,
    serviceId: svc.id,
    trigger: "rollback",
  });

  const mgrSpec = await specOf();
  if (mgrSpec.constraints.includes(`node.id==${managerNodeId}`)) {
    ok("pinned to the manager, even though the cluster has two nodes");
  } else {
    ko(
      `no constraint: [${mgrSpec.constraints.join(", ")}] — Swarm could place it on the worker, without the image`
    );
  }

  await db
    .update(services)
    .set({ serverId: workerRow.id })
    .where(eq(services.id, svc.id));

  step("Retention");
  const volumeMb = async (): Promise<number> => {
    const res = await exec(
      managerSsh as Awaited<ReturnType<typeof connect>>,
      `sudo docker exec ${REGISTRY_CONTAINER} du -sm /var/lib/registry`
    );
    return Math.trunc(Number(res.stdout.trim().split(FIRST_FIELD)[0] ?? "0"));
  };

  const fatTag = registryImageTag(registry, swarmName, `fat-${Date.now()}`);
  await exec(
    managerSsh,
    "sudo rm -rf /tmp/fat && mkdir -p /tmp/fat && cd /tmp/fat && " +
      "head -c 120000000 /dev/urandom > gros.bin && " +
      `printf 'FROM alpine:3\\nCOPY gros.bin /gros.bin\\n' > Dockerfile && ` +
      `sudo docker build -q -t ${quoteArg(fatTag)} .`
  );
  await pushImage(managerSsh, registry, {
    imageTag: fatTag,
    removeLocal: true,
  });

  const [fatDep] = await db
    .insert(deployments)
    .values({
      imageTag: fatTag,
      serviceId: svc.id,
      status: "succeeded",
      trigger: "manual",
    })
    .returning();
  const padIds: string[] = [];
  for (let i = 0; i < KEEP_PER_SERVICE; i += 1) {
    const [pad] = await db
      .insert(deployments)
      .values({
        imageTag: registryImageTag(registry, swarmName, `pad-${i}`),
        serviceId: svc.id,
        status: "succeeded",
        trigger: "manual",
      })
      .returning();
    if (pad) {
      padIds.push(pad.id);
    }
  }

  const before = await volumeMb();
  const swept = await sweepRegistry(ctx, { containerName: REGISTRY_CONTAINER });
  const after = await volumeMb();

  if (swept.purged.includes(fatTag)) {
    ok(`the out-of-window version is purged (${swept.purged.length} total)`);
  } else {
    ko(`the out-of-window version wasn't purged: ${swept.purged.join(", ")}`);
  }

  const purgedRow = await db.query.deployments.findFirst({
    where: eq(deployments.id, fatDep?.id ?? ""),
  });
  if (purgedRow?.imagePurged) {
    ok("the history ROW stays, marked as purged");
  } else {
    ko("image_purged wasn't set on the row");
  }

  if (swept.collected && before - after > 50) {
    ok(`garbage-collect reclaimed ${before - after} MB (${before} → ${after})`);
  } else {
    ko(
      `volume ${before} → ${after} MB, collected=${swept.collected} — the row is erased but the OBJECT stayed`
    );
  }

  const survivors = await db.query.deployments.findMany({
    where: inArray(deployments.id, padIds),
  });
  if (survivors.length > 0 && survivors.every((d) => !d.imagePurged)) {
    ok(`the ${survivors.length} versions within the window are spared`);
  } else {
    ko(
      `${survivors.filter((d) => d.imagePurged).length} version(s) within the window were purged`
    );
  }

  step("Service deletion");
  await runServiceTeardown(ctx, svc.id, {
    containerName: REGISTRY_CONTAINER,
  });

  const swarmAfter = await managerDocker.listServices({
    filters: JSON.stringify({ name: [swarmName] }),
  });
  if (swarmAfter.every((s) => s.Spec?.Name !== swarmName)) {
    ok("the Swarm service is gone");
  } else {
    ko("the Swarm service is still running — Traefik still routes to it");
  }

  const rowAfter = await db.query.services.findFirst({
    where: eq(services.id, svc.id),
  });
  const depsAfter = await db.query.deployments.findMany({
    where: eq(deployments.serviceId, svc.id),
  });
  if (!rowAfter && depsAfter.length === 0) {
    ok("the row and its whole history are gone (cascade)");
  } else {
    ko(
      `still in the database: service=${rowAfter ? "yes" : "no"}, deployments=${depsAfter.length}`
    );
  }

  const catalogAfter = await exec(
    managerSsh,
    `curl -sS --cacert /etc/docker/certs.d/${registry.host}/ca.crt ` +
      `-u noddle:${quoteArg(registryPassword)} https://${registry.host}/v2/${swarmName}/tags/list`
  );
  if (
    catalogAfter.stdout.includes('"tags":null') ||
    catalogAfter.stdout.includes("NAME_UNKNOWN")
  ) {
    ok("the registry repository is empty");
  } else {
    ko(`tags remain: ${catalogAfter.stdout.trim().slice(0, 120)}`);
  }

  const workdirAfter = await exec(
    workerSsh,
    `test -d ${quoteArg(`/var/lib/noddle/builds/${svc.id}`)} && echo present || echo absent`
  );
  if (workdirAfter.stdout.includes("absent")) {
    ok("the build directory was removed from the node");
  } else {
    ko("the build directory still lingers");
  }

  await runServiceTeardown(ctx, svc.id, {
    containerName: REGISTRY_CONTAINER,
  });
  ok("teardown is replayable without error (idempotent)");
} catch (error) {
  ko(`interrupted: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (workerSsh) {
    disconnect(workerSsh);
  }
  if (managerSsh) {
    disconnect(managerSsh);
  }
  console.log(
    `\n\u001B[1m${pass} passed, ${fail} failed\u001B[0m${
      fail === 0 ? " \u001B[32m✓\u001B[0m\n" : " \u001B[31m✗\u001B[0m\n"
    }`
  );
  process.exit(fail === 0 ? 0 : 1);
}
