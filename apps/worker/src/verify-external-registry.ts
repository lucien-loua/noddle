// MANAGER_HOST=192.168.252.3 WORKER_HOST=192.168.252.5 DATABASE_URL=… node apps/worker/src/verify-external-registry.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  registries,
  servers,
  services,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
  quoteArg,
} from "@noddle/ssh-executor";
import { eq, inArray } from "drizzle-orm";
import { runDeploy } from "#deploy";
import { provisionServer } from "#provision";
import { removeService } from "#swarm";
import { seedSshKey } from "#verify-seed";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const MANAGER_HOST = process.env.MANAGER_HOST ?? "192.168.252.3";
const WORKER_HOST = process.env.WORKER_HOST ?? "192.168.252.5";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const SERVICE_NAME = "noddle-ext";
const ORIGIN = "/opt/noddle-ext-origin";
const EXT_DIR = "/etc/noddle/registry-ext";
const EXT_CONTAINER = "noddle-registry-ext";
const EXT_PORT = 5001;
const EXT_USER = "octocat";
const EXT_PREFIX = "acme-org";

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
const step = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");
const sshKeyId = await seedSshKey(db, appKey, "verify-external", privateKey);
const extPassword = randomBytes(16).toString("hex");
const extHost = `${MANAGER_HOST}:${EXT_PORT}`;
const domain = `${SERVICE_NAME}.${MANAGER_HOST.replaceAll(".", "-")}.sslip.io`;

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;
let workerSsh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(deployments);
await db.delete(services);
await db.delete(environments);
await db.delete(projects);
await db.delete(registries);
await db
  .delete(servers)
  .where(inArray(servers.host, [MANAGER_HOST, WORKER_HOST]));

try {
  managerSsh = await connect({ host: MANAGER_HOST, privateKey, user: USER });
  workerSsh = await connect({ host: WORKER_HOST, privateKey, user: USER });
  const managerDocker = dockerClient(managerSsh);

  // ── staging: a SECOND registry, standing in for an external one ─────────
  step("An external registry, distinct credentials and port");
  await exec(managerSsh, `sudo docker rm -f ${EXT_CONTAINER}`);
  await exec(
    managerSsh,
    `sudo rm -rf ${EXT_DIR} && sudo mkdir -p ${EXT_DIR} && ` +
      "sudo openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes " +
      `-keyout ${EXT_DIR}/ca.key -out ${EXT_DIR}/ca.crt ` +
      "-subj '/CN=Acme Registry CA' " +
      "-addext 'basicConstraints=critical,CA:TRUE' " +
      "-addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null && " +
      `printf 'subjectAltName=IP:${MANAGER_HOST}\\nbasicConstraints=CA:FALSE\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\n' | sudo tee ${EXT_DIR}/ext.cnf >/dev/null && ` +
      `sudo openssl req -newkey rsa:2048 -nodes -keyout ${EXT_DIR}/registry.key ` +
      `-out ${EXT_DIR}/registry.csr -subj '/CN=${MANAGER_HOST}' 2>/dev/null && ` +
      `sudo openssl x509 -req -in ${EXT_DIR}/registry.csr -CA ${EXT_DIR}/ca.crt ` +
      `-CAkey ${EXT_DIR}/ca.key -CAcreateserial -out ${EXT_DIR}/registry.crt ` +
      `-days 3650 -sha256 -extfile ${EXT_DIR}/ext.cnf 2>/dev/null`
  );
  const htpasswd = await exec(
    managerSsh,
    `printf '%s' ${quoteArg(extPassword)} | sudo docker run --rm -i httpd:2-alpine htpasswd -Bin ${EXT_USER} 2>/dev/null | sudo tee ${EXT_DIR}/htpasswd`
  );
  if (htpasswd.stdout.includes("$2y$")) {
    ok(`htpasswd bcrypt for "${EXT_USER}", a different account from ours`);
  } else {
    ko(`unexpected htpasswd: ${htpasswd.stdout.slice(0, 60)}`);
  }

  await execArgv(managerSsh, [
    "sudo",
    "docker",
    "run",
    "-d",
    "--name",
    EXT_CONTAINER,
    "--restart",
    "unless-stopped",
    "-p",
    `${EXT_PORT}:5000`,
    "-v",
    `${EXT_DIR}:/certs:ro`,
    "-e",
    "REGISTRY_HTTP_ADDR=0.0.0.0:5000",
    "-e",
    "REGISTRY_HTTP_TLS_CERTIFICATE=/certs/registry.crt",
    "-e",
    "REGISTRY_HTTP_TLS_KEY=/certs/registry.key",
    "-e",
    "REGISTRY_AUTH=htpasswd",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_REALM=acme",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_PATH=/certs/htpasswd",
    "registry:3.1.1",
  ]);
  await sleep(4000);
  const alive = await exec(
    managerSsh,
    `sudo docker inspect -f '{{.State.Running}}' ${EXT_CONTAINER}`
  );
  if (alive.stdout.trim() === "true") {
    ok(`external registry listening on ${extHost}`);
  } else {
    const why = await exec(
      managerSsh,
      `sudo docker logs --tail 5 ${EXT_CONTAINER}`
    );
    ko(`external registry dead: ${why.stderr.trim() || why.stdout.trim()}`);
    throw new Error("external registry unavailable");
  }

  // CA installed OUTSIDE Noddle on both nodes: for an external registry
  // `caCert` is `undefined`, so Noddle deposits NOTHING. Correct for ghcr.io
  // (public CA); a self-hosted registry with a private cert needs the CA
  // already trusted on the nodes.
  const caCert = (
    await exec(managerSsh, `sudo cat ${EXT_DIR}/ca.crt`)
  ).stdout.trim();
  for (const client of [managerSsh, workerSsh]) {
    // biome-ignore lint/performance/noAwaitInLoops: two nodes, sequential by design
    await exec(
      client,
      `sudo mkdir -p /etc/docker/certs.d/${extHost} && ` +
        `printf '%s' ${quoteArg(caCert)} | sudo tee /etc/docker/certs.d/${extHost}/ca.crt >/dev/null`
    );
  }
  ok("external registry CA deposited on both nodes, outside Noddle");

  // ── the `registries` row, as the UI would write it ──────────────────────
  step("The registry chosen by the service");
  const registryId = crypto.randomUUID();
  await db.insert(registries).values({
    id: registryId,
    imagePrefix: EXT_PREFIX,
    name: "acme",
    passwordEncrypted: encryptSecret(
      extPassword,
      appKey,
      secretContext.registry(registryId)
    ),
    registryUrl: extHost,
    username: EXT_USER,
  });
  ok("registries row written, password encrypted under its AAD");

  const [managerRow] = await db
    .insert(servers)
    .values({
      host: MANAGER_HOST,
      name: "ext-manager",
      role: "manager",
      sshKeyId,
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  const [workerRow] = await db
    .insert(servers)
    .values({ host: WORKER_HOST, name: "ext-worker", sshKeyId, sshUser: USER })
    .returning();
  if (!(managerRow && workerRow)) {
    throw new Error("server insert failed");
  }

  // No embedded registry in this context: if the code fell back to it, the
  // deploy would fail instead of silently going to the wrong place. A false
  // green is thus impossible.
  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-ext-logs",
    networkName: "noddle-public",
    registry: undefined,
  };

  console.log("    (provisioning the worker…)");
  await provisionServer(ctx, workerRow.id);

  // ── the origin repo, on the worker ──────────────────────────────────────
  step("Deploy to the external registry");
  await exec(
    workerSsh,
    `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
      `cd ${quoteArg(ORIGIN)} && ` +
      `printf '%s' '{"name":"ext","scripts":{"start":"node s.js"}}' > package.json && ` +
      `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("external hello")).listen(p)' > s.js && ` +
      "git init -q -b main . && git config user.email e@x && git config user.name e && " +
      "git add -A && git commit -q -m init"
  );

  const leftovers = await managerDocker.listServices({
    filters: JSON.stringify({ name: [SERVICE_NAME] }),
  });
  for (const old of leftovers) {
    const name = old.Spec?.Name;
    if (name?.startsWith(`${SERVICE_NAME}-`)) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
      await removeService(managerDocker, name);
    }
  }

  const [proj] = await db.insert(projects).values({ name: "ext" }).returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      buildMethod: "nixpacks",
      domain,
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: `file://${ORIGIN}`,
      name: SERVICE_NAME,
      port: 3000,
      registryId,
      serverId: workerRow.id,
      sourceType: "git",
    })
    .returning();
  if (!svc) {
    throw new Error("service insert failed");
  }

  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep) {
    throw new Error("deployment insert failed");
  }

  console.log("    (nixpacks build on the worker, push to the external…)");
  await runDeploy(ctx, { deploymentId: dep.id });

  const done = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep.id),
  });
  if (done?.status === "succeeded") {
    ok(`deployment succeeded — ${done.imageTag}`);
  } else {
    ko(`deployment ${done?.status}: ${done?.errorMessage ?? ""}`);
    throw new Error("deployment failed; the rest is meaningless");
  }

  // THE point of the test: the user's host AND prefix, not ours.
  const tag = done.imageTag ?? "";
  if (tag.startsWith(`${extHost}/${EXT_PREFIX}/`)) {
    ok(`tag carries the chosen host AND prefix: ${extHost}/${EXT_PREFIX}/…`);
  } else {
    ko(`unexpected tag: ${tag}`);
  }

  // And the image is REALLY there: we query the external registry.
  const catalog = await exec(
    managerSsh,
    `curl -s --cacert ${EXT_DIR}/ca.crt -u ${quoteArg(`${EXT_USER}:${extPassword}`)} https://${extHost}/v2/_catalog`
  );
  if (catalog.stdout.includes(`${EXT_PREFIX}/${SERVICE_NAME}`)) {
    ok(`external registry holds the repo: ${catalog.stdout.trim()}`);
  } else {
    ko(`repo absent from external registry: ${catalog.stdout.trim()}`);
  }

  // The service must NOT be pinned: the image is pullable everywhere.
  const swarmName = tag.split("/").pop()?.split(":")[0] ?? "";
  const listed = await managerDocker.listServices({
    filters: JSON.stringify({ name: [SERVICE_NAME] }),
  });
  const spec = listed.find((s) => s.Spec?.Name?.startsWith(`${SERVICE_NAME}-`));
  const constraints = spec?.Spec?.TaskTemplate?.Placement?.Constraints ?? [];
  if (constraints.length === 0) {
    ok("no placement constraint: the image is portable");
  } else {
    ko(`unexpected constraint: ${constraints.join(", ")}`);
  }

  // ── the proof that matters: ANOTHER node pulls from the external ────────
  step("A node that never built the image pulls it from the external");
  const buildNode = (
    await exec(workerSsh, "sudo docker info -f '{{.Swarm.NodeID}}'")
  ).stdout.trim();
  await exec(
    managerSsh,
    `sudo docker node update --availability drain ${buildNode}`
  );
  try {
    let landed = "";
    for (let i = 0; i < 30; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: intentional polling
      await sleep(3000);
      const ps = await exec(
        managerSsh,
        `sudo docker service ps --filter desired-state=running --format '{{.Node}} {{.CurrentState}}' ${quoteArg(spec?.Spec?.Name ?? swarmName)}`
      );
      if (ps.stdout.includes("Running")) {
        landed = ps.stdout.trim();
        break;
      }
    }
    if (landed && !landed.startsWith("ext-worker")) {
      ok(`rescheduled off the build node: ${landed.split("\n")[0]}`);
    } else if (landed) {
      ko(`still on the build node: ${landed}`);
    } else {
      ko("task never returned to running after drain");
    }

    const http = await exec(
      managerSsh,
      `curl -s -m 10 -H ${quoteArg(`Host: ${domain}`)} http://127.0.0.1/`
    );
    if (http.stdout.includes("external hello")) {
      ok("HTTP served from the node that PULLED the image from the external");
    } else {
      ko(`unexpected HTTP: ${http.stdout.slice(0, 80)}`);
    }
  } finally {
    await exec(
      managerSsh,
      `sudo docker node update --availability active ${buildNode}`
    );
  }
} catch (err) {
  ko(`interrupted: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (managerSsh) {
    await exec(managerSsh, `sudo docker rm -f ${EXT_CONTAINER}`);
    disconnect(managerSsh);
  }
  if (workerSsh) {
    disconnect(workerSsh);
  }
}

console.log(
  `\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m ${fail === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`
);
process.exit(fail === 0 ? 0 : 1);
