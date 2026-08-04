// Le registre, contre DEUX VM réelles.
//
// Ce que ce test pose, et qu'aucun autre ne peut poser : une image construite
// sur un nœud tourne-t-elle sur un AUTRE ? Tout le chantier Phase 4 tient à
// cette question, et elle ne se répond ni au typecheck ni sur une seule
// machine — il faut un second démon Docker qui n'a jamais vu l'image.
//
//   MANAGER_HOST=192.168.252.3 WORKER_HOST=192.168.252.5 \
//     DATABASE_URL=… node apps/worker/src/verify-registry.ts
//
// Le manager doit DÉJÀ être en Swarm. Le worker peut être nu ou déjà membre :
// `provisionServer` est idempotent.
//
// ⚠ Ce script monte SON registre sur le manager, avec les mêmes commandes
// openssl que `installer/install.sh`. Il ne vérifie donc PAS l'installateur —
// ça, c'est une installation réelle sur une machine neuve, séparément.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
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
import { redeployImage, runDeploy } from "#deploy";
import { provisionServer } from "#provision";
import { ensureRegistryTrust, pushImage, type RegistryConfig } from "#registry";
import { removeService } from "#swarm";

const execFileAsync = promisify(execFile);

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const MANAGER_HOST = process.env.MANAGER_HOST ?? "192.168.252.3";
const WORKER_HOST = process.env.WORKER_HOST ?? "192.168.252.5";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const SERVICE_NAME = "noddle-reg";
const ORIGIN = "/opt/noddle-reg-origin";
const CERT_DIR = "/etc/noddle/registry";
const REGISTRY_CONTAINER = "noddle-registry";

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
const registryPassword = randomBytes(16).toString("hex");
const domain = `${SERVICE_NAME}.${MANAGER_HOST.replaceAll(".", "-")}.sslip.io`;

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;
let workerSsh: Awaited<ReturnType<typeof connect>> | undefined;

/** L'horodatage de démarrage du démon Docker — pour prouver qu'il n'a PAS redémarré. */
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
  .where(inArray(servers.host, [MANAGER_HOST, WORKER_HOST]));

try {
  managerSsh = await connect({ host: MANAGER_HOST, privateKey, user: USER });
  const managerDocker = dockerClient(managerSsh);

  // ── décor : le registre sur le manager ────────────────────────────────────
  //
  // Mêmes commandes qu'install.sh. Reproduites ici et non partagées : un
  // helper commun ferait passer le test et l'installateur par le même code, et
  // le test cesserait de pouvoir détecter que l'installateur a divergé.
  step("Registre sur le manager");
  await exec(managerSsh, `sudo docker rm -f ${REGISTRY_CONTAINER}`);
  await exec(
    managerSsh,
    `sudo rm -rf ${CERT_DIR} && sudo mkdir -p ${CERT_DIR} && ` +
      "sudo openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes " +
      `-keyout ${CERT_DIR}/ca.key -out ${CERT_DIR}/ca.crt ` +
      `-subj '/CN=Noddle Registry CA' ` +
      `-addext 'basicConstraints=critical,CA:TRUE' ` +
      `-addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null && ` +
      `printf 'subjectAltName=IP:${MANAGER_HOST}\\nbasicConstraints=CA:FALSE\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\n' | sudo tee ${CERT_DIR}/ext.cnf >/dev/null && ` +
      `sudo openssl req -newkey rsa:2048 -nodes -keyout ${CERT_DIR}/registry.key ` +
      `-out ${CERT_DIR}/registry.csr -subj '/CN=${MANAGER_HOST}' 2>/dev/null && ` +
      `sudo openssl x509 -req -in ${CERT_DIR}/registry.csr -CA ${CERT_DIR}/ca.crt ` +
      `-CAkey ${CERT_DIR}/ca.key -CAcreateserial -out ${CERT_DIR}/registry.crt ` +
      `-days 3650 -sha256 -extfile ${CERT_DIR}/ext.cnf 2>/dev/null`
  );
  const htpasswd = await exec(
    managerSsh,
    `printf '%s' ${quoteArg(registryPassword)} | sudo docker run --rm -i httpd:2-alpine htpasswd -Bin noddle 2>/dev/null | sudo tee ${CERT_DIR}/htpasswd`
  );
  if (htpasswd.stdout.includes("$2y$")) {
    ok("AC, certificat et htpasswd bcrypt générés");
  } else {
    ko(`htpasswd inattendu : ${htpasswd.stdout.slice(0, 60)}`);
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
    ok("registry:3.1.1 démarré en TLS + auth");
  } else {
    const why = await exec(
      managerSsh,
      `sudo docker logs --tail 5 ${REGISTRY_CONTAINER}`
    );
    ko(`registre mort : ${why.stderr.trim() || why.stdout.trim()}`);
    throw new Error("registre indisponible, la suite n'a pas de sens");
  }

  const caCert = (
    await exec(managerSsh, `sudo cat ${CERT_DIR}/ca.crt`)
  ).stdout.trim();
  const registry: RegistryConfig = {
    caCert,
    host: `${MANAGER_HOST}:5000`,
    password: registryPassword,
  };

  // ── LE point de la décision TLS : confiance sans redémarrage ──────────────
  step("Confiance sans redémarrage du démon");
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
    (e: Error) => e.message
  );
  if (beforeTrust?.includes("x509") || beforeTrust?.includes("certificate")) {
    ok("sans l'AC : push refusé, et l'erreur NOMME le certificat");
  } else {
    ko(`sans l'AC, erreur inattendue : ${beforeTrust ?? "aucune erreur !"}`);
  }

  const wrote = await ensureRegistryTrust(managerSsh, registry);
  const rewrote = await ensureRegistryTrust(managerSsh, registry);
  if (wrote && !rewrote) {
    ok("AC déposée, puis rejouée sans réécriture (idempotent)");
  } else {
    ko(`dépôt de l'AC : écrit=${wrote}, réécrit=${rewrote}`);
  }

  await pushImage(managerSsh, registry, {
    imageTag: `${registry.host}/probe-nocert:v1`,
  });
  const startedAfter = await dockerStartedAt(managerSsh);
  if (startedBefore === startedAfter && startedBefore !== "") {
    ok(`push accepté SANS redémarrage du démon (démarré ${startedAfter})`);
  } else {
    ko(`le démon a redémarré : ${startedBefore} → ${startedAfter}`);
  }

  // ── les deux serveurs en base ─────────────────────────────────────────────
  step("Serveurs");
  const [managerRow] = await db
    .insert(servers)
    .values({
      host: MANAGER_HOST,
      name: "reg-manager",
      role: "manager",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!managerRow) {
    throw new Error("insertion manager échouée");
  }
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(managerRow.id)
      ),
    })
    .where(eq(servers.id, managerRow.id));

  const [workerRow] = await db
    .insert(servers)
    .values({
      host: WORKER_HOST,
      name: "reg-worker",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
    })
    .returning();
  if (!workerRow) {
    throw new Error("insertion worker échouée");
  }
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(workerRow.id)
      ),
    })
    .where(eq(servers.id, workerRow.id));

  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-reg-logs",
    networkName: "noddle-public",
    registry,
  };

  console.log("    (provisionnement du worker : Docker, jonction, AC…)");
  await provisionServer(ctx, workerRow.id);

  const provisioned = await db.query.servers.findFirst({
    where: eq(servers.id, workerRow.id),
  });
  if (provisioned?.status === "connected" && provisioned.swarmNodeId) {
    ok(
      `worker provisionné, nœud Swarm ${provisioned.swarmNodeId.slice(0, 12)}`
    );
  } else {
    ko(
      `provisionnement : ${provisioned?.status}, nœud ${provisioned?.swarmNodeId ?? "—"}, ${provisioned?.lastError ?? ""}`
    );
  }

  workerSsh = await connect({ host: WORKER_HOST, privateKey, user: USER });
  const caOnWorker = await exec(
    workerSsh,
    `sudo cat /etc/docker/certs.d/${registry.host}/ca.crt`
  );
  if (
    caOnWorker.code === 0 &&
    caOnWorker.stdout.includes("BEGIN CERTIFICATE")
  ) {
    ok("l'AC est arrivée sur le worker, par le provisionnement");
  } else {
    ko("l'AC n'est pas sur le worker");
  }

  // ── un service construit sur le WORKER ────────────────────────────────────
  step("Déploiement : construit sur le worker, poussé, non épinglé");
  await exec(
    workerSsh,
    `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
      `cd ${quoteArg(ORIGIN)} && ` +
      `printf '%s' '{"name":"reg","scripts":{"start":"node s.js"}}' > package.json && ` +
      `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("registre bonjour")).listen(p)' > s.js && ` +
      "git init -q -b main . && git config user.email e@x && git config user.name e && " +
      "git add -A && git commit -q -m init"
  );

  await removeService(managerDocker, SERVICE_NAME);

  const [proj] = await db.insert(projects).values({ name: "reg" }).returning();
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
      serverId: workerRow.id,
      sourceType: "git",
    })
    .returning();
  if (!svc) {
    throw new Error("insertion service échouée");
  }

  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep) {
    throw new Error("insertion déploiement échouée");
  }

  console.log("    (build nixpacks sur le worker, push, bascule Swarm…)");
  await runDeploy(ctx, { deploymentId: dep.id });

  const final = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep.id),
  });
  if (final?.status === "succeeded") {
    ok(`déploiement succeeded — ${final.imageTag}`);
  } else {
    ko(`statut ${final?.status} — ${final?.errorMessage ?? ""}`);
    throw new Error("déploiement échoué, la suite n'a pas de sens");
  }

  if (final.imageTag?.startsWith(`${registry.host}/`)) {
    ok("le tag porte l'hôte du registre");
  } else {
    ko(`tag non qualifié : ${final.imageTag}`);
  }

  // L'image est-elle VRAIMENT dans le registre ? Question posée au registre,
  // pas déduite d'un code de sortie.
  const catalog = await exec(
    managerSsh,
    `curl -sS --cacert /etc/docker/certs.d/${registry.host}/ca.crt ` +
      `-u noddle:${quoteArg(registryPassword)} https://${registry.host}/v2/_catalog`
  );
  if (catalog.stdout.includes(SERVICE_NAME)) {
    ok(`le registre expose le dépôt : ${catalog.stdout.trim()}`);
  } else {
    ko(`dépôt absent du catalogue : ${catalog.stdout.trim()}`);
  }

  // `removeLocal` se vérifie ISOLÉMENT, sur une image que rien ne déploie.
  //
  // L'asserter sur l'image du service donnerait un faux négatif : elle est
  // bien retirée après le push, puis Swarm place la task sur ce même nœud et
  // le démon la RE-TIRE du registre. Elle est donc présente à l'arrivée, pour
  // une raison qui est le fonctionnement voulu. Mesuré — c'est ce qu'a montré
  // la première exécution de ce fichier.
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
    ok("`removeLocal` retire bien la copie locale après un push réussi");
  } else {
    ko("la copie locale traîne après un push avec removeLocal");
  }

  // ── LE test : aucune contrainte de placement ──────────────────────────────
  const specOf = async (): Promise<{
    constraints: string[];
    image: string;
  }> => {
    const list = (await managerDocker.listServices({
      filters: JSON.stringify({ name: [SERVICE_NAME] }),
    })) as unknown as Array<{
      Spec?: {
        Name?: string;
        TaskTemplate?: {
          ContainerSpec?: { Image?: string };
          Placement?: { Constraints?: string[] };
        };
      };
    }>;
    const found = list.find((s) => s.Spec?.Name === SERVICE_NAME);
    return {
      constraints: found?.Spec?.TaskTemplate?.Placement?.Constraints ?? [],
      image: found?.Spec?.TaskTemplate?.ContainerSpec?.Image ?? "",
    };
  };

  const portableSpec = await specOf();
  if (portableSpec.constraints.length === 0) {
    ok("le service n'a AUCUNE contrainte de placement");
  } else {
    ko(`contrainte inattendue : ${portableSpec.constraints.join(", ")}`);
  }

  if (final.nodeId) {
    ok(`le nœud d'exécution est relevé : ${final.nodeId.slice(0, 12)}`);
  } else {
    ko("node_id non relevé");
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const httpCheck = async (label: string): Promise<boolean> => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: réessai volontaire — le provider Swarm de Traefik scrute toutes les 15 s
      const res = await execFileAsync(
        "curl",
        [
          "-fsS",
          "--max-time",
          "10",
          "-H",
          `Host: ${domain}`,
          `http://${MANAGER_HOST}/`,
        ],
        { timeout: 12_000 }
      ).catch(() => null);
      if (res?.stdout.includes("registre")) {
        ok(`${label} : « ${res.stdout.trim()} »`);
        return true;
      }
      await sleep(3000);
    }
    ko(`${label} : pas de réponse en 120 s`);
    return false;
  };
  await httpCheck("HTTP à travers l'overlay");

  // ── LA question du chantier : l'image tourne-t-elle sur un AUTRE nœud ? ────
  //
  // On vide le nœud de build. Sans registre, Swarm n'aurait nulle part où
  // aller : l'image n'existe que là. Avec registre, le manager doit la TIRER
  // et servir — c'est la preuve de portabilité, et accessoirement la reprise
  // sur panne de nœud que Swarm ne pouvait pas offrir jusqu'ici.
  step("Portabilité : on vide le nœud qui a construit l'image");
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
    // biome-ignore lint/performance/noAwaitInLoops: sondage volontaire
    const tasks = (await managerDocker.listTasks({
      filters: JSON.stringify({ service: [SERVICE_NAME] }),
    })) as unknown as Array<{
      NodeID?: string;
      Status?: { State?: string };
    }>;
    const running = tasks.find((t) => t.Status?.State === "running");
    if (running?.NodeID && running.NodeID !== workerNodeId) {
      movedTo = running.NodeID;
      break;
    }
    await sleep(4000);
  }

  if (movedTo) {
    ok(
      `la task a été REPLANIFIÉE sur ${movedTo.slice(0, 12)} — un nœud qui n'a jamais construit cette image`
    );
  } else {
    ko("la task n'a pas été replanifiée en 180 s");
  }

  await httpCheck("HTTP depuis le nœud qui a TIRÉ l'image");

  await execArgv(managerSsh, [
    "sudo",
    "docker",
    "node",
    "update",
    "--availability",
    "active",
    workerNodeId,
  ]);

  // ── rollback vers une image du registre ───────────────────────────────────
  step("Rollback");
  if (final.imageTag) {
    await redeployImage(ctx, {
      imageTag: final.imageTag,
      serviceId: svc.id,
      trigger: "rollback",
    });
    const after = await db.query.deployments.findFirst({
      orderBy: (d, { desc }) => desc(d.createdAt),
      where: eq(deployments.serviceId, svc.id),
    });
    if (after?.status === "succeeded") {
      ok("rollback vers une image du registre accepté");
    } else {
      ko(`rollback : ${after?.status} — ${after?.errorMessage ?? ""}`);
    }
  }

  // ── LA migration : un rollback vers une image d'AVANT le registre ─────────
  //
  // Le cas qui pourrirait en silence. Ces images n'existent que sur leur nœud ;
  // si le placement était devenu libre pour tout le monde, Swarm en choisirait
  // un autre et la task ne démarrerait jamais — avec pour seul symptôme un
  // « n'a pas convergé en 180 s » qui ne dit rien de la cause.
  step("Migration : rollback vers une image d'avant le registre");
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
    ok("image « héritée » construite localement sur le worker, non poussée");
  } else {
    ko("la construction de l'image héritée a échoué");
  }

  await redeployImage(ctx, {
    imageTag: legacyTag,
    serviceId: svc.id,
    trigger: "rollback",
  });

  const legacySpec = await specOf();
  if (legacySpec.constraints.some((c) => c === `node.id==${workerNodeId}`)) {
    ok(
      "une image NON poussée reste épinglée à son nœud — la migration ne casse rien"
    );
  } else {
    ko(
      `image héritée sans contrainte : [${legacySpec.constraints.join(", ")}] — un rollback partirait vers un nœud sans l'image`
    );
  }

  const legacyDep = await db.query.deployments.findFirst({
    orderBy: (d, { desc }) => desc(d.createdAt),
    where: eq(deployments.serviceId, svc.id),
  });
  if (legacyDep?.status === "succeeded") {
    ok("et le rollback hérité converge quand même");
  } else {
    ko(`rollback hérité : ${legacyDep?.status} — ${legacyDep?.errorMessage}`);
  }
} catch (err) {
  // SANS ce bloc, une exception traverse jusqu'au `finally`, qui sort en 0
  // parce qu'aucun `ko()` n'a été compté — un banc d'essai qui annonce « 7
  // réussis ✓ » sur un déploiement qui n'a jamais abouti. Payé à la première
  // exécution de ce fichier, et c'est la même leçon que le montage silencieux
  // de `verify-backup.ts` : un test doit échouer BRUYAMMENT sur sa propre
  // panne, pas seulement sur les assertions qu'il a eu le temps d'atteindre.
  ko(`interrompu : ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (workerSsh) {
    disconnect(workerSsh);
  }
  if (managerSsh) {
    disconnect(managerSsh);
  }
  console.log(
    `\n\x1b[1m${pass} réussis, ${fail} échoués\x1b[0m` +
      (fail === 0 ? " \x1b[32m✓\x1b[0m\n" : " \x1b[31m✗\x1b[0m\n")
  );
  process.exit(fail === 0 ? 0 : 1);
}
