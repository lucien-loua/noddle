// Multi-serveur : deux VM réelles, un manager et un worker qui la rejoint.
//
// Ce qu'aucun autre test ne pose : un service épinglé sur un nœud qui n'est
// PAS le manager répond-il vraiment, à travers le réseau overlay, derrière le
// Traefik qui tourne sur l'autre machine ? C'est le cas que CLAUDE.md appelle
// « le jour où le multi-nœud arrive » — VXLAN réel, pas une seule VM.
//
//   MANAGER_HOST=192.168.252.3 WORKER_HOST=192.168.252.5 \
//     DATABASE_URL=… node apps/worker/src/verify-multi.ts
//
// Le manager doit DÉJÀ être en Swarm (n'importe quelle VM du dépôt qui a servi
// à un test Phase 0/1 l'est) ; le worker doit être NU — sans Docker — pour que
// ce test prouve le provisionnement, pas juste sa partie idempotente.
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
  quoteArg,
} from "@noddle/ssh-executor";
import { eq, inArray } from "drizzle-orm";
import { runDeploy } from "#deploy";
import { provisionServer } from "#provision";
import { removeService } from "#swarm";

const execFileAsync = promisify(execFile);

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const MANAGER_HOST = process.env.MANAGER_HOST ?? "192.168.252.3";
const WORKER_HOST = process.env.WORKER_HOST ?? "192.168.252.5";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const SERVICE_NAME = "noddle-multi";
const ORIGIN = "/opt/noddle-multi-origin";

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
const domain = `${SERVICE_NAME}.${WORKER_HOST.replaceAll(".", "-")}.sslip.io`;

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

// Rejouable : une exécution précédente (celle-ci ou verify-live.ts, qui
// partage la même base locale de vérification) peut avoir laissé un serveur
// sur CES MÊMES hôtes. L'index unique (host, port, user) collision sinon.
await db.delete(deployments);
await db.delete(services);
await db.delete(environments);
await db.delete(projects);
await db
  .delete(servers)
  .where(inArray(servers.host, [MANAGER_HOST, WORKER_HOST]));

try {
  // ── décor : les deux serveurs en base ─────────────────────────────────────
  const [managerRow] = await db
    .insert(servers)
    .values({
      host: MANAGER_HOST,
      name: "multi-manager",
      role: "manager",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
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
      status: "connected",
    })
    .where(eq(servers.id, managerRow.id));
  ok("manager enregistré (role=manager)");

  const [workerRow] = await db
    .insert(servers)
    .values({
      host: WORKER_HOST,
      name: "multi-worker",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
      // role par défaut : "worker" — jamais posé explicitement, exactement
      // comme le ferait la server function `addServer`.
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
  ok("worker enregistré, en attente (status=pending)");

  // ── LE provisionnement : Docker, jonction Swarm, nixpacks ─────────────────
  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-multi-logs",
    networkName: "noddle-public",
  };

  console.log("    (provisionnement du worker — Docker, jonction, nixpacks…)");
  await provisionServer(ctx, workerRow.id);

  const provisioned = await db.query.servers.findFirst({
    where: eq(servers.id, workerRow.id),
  });
  if (provisioned?.status === "connected" && provisioned.dockerVersion) {
    ok(`worker provisionné : Docker ${provisioned.dockerVersion}`);
  } else {
    ko(
      `provisionnement : statut ${provisioned?.status}, erreur ${provisioned?.lastError ?? "—"}`
    );
  }

  // Rejoué : la seconde exécution doit être un no-op silencieux, pas une
  // seconde tentative de `swarm join` sur un nœud déjà membre.
  await provisionServer(ctx, workerRow.id);
  ok("provisionnement rejouable sans erreur (idempotent)");

  // ── vérité Swarm : deux nœuds, pas un ─────────────────────────────────────
  managerSsh = await connect({ host: MANAGER_HOST, privateKey, user: USER });
  const managerDocker = dockerClient(managerSsh);
  const nodes = (await managerDocker.listNodes()) as Array<{
    ID?: string;
    Spec?: { Role?: string };
    Status?: { State?: string };
  }>;
  const workerNodes = nodes.filter((n) => n.Spec?.Role === "worker");
  if (nodes.length >= 2 && workerNodes.length >= 1) {
    ok(
      `cluster à ${nodes.length} nœuds vu depuis le manager (${workerNodes.length} worker)`
    );
  } else {
    ko(
      `cluster inattendu : ${nodes.length} nœud(s), ${workerNodes.length} worker(s)`
    );
  }

  // ── dépôt source sur le WORKER, pas sur le manager ────────────────────────
  const workerSsh = await connect({
    host: WORKER_HOST,
    privateKey,
    user: USER,
  });
  try {
    await exec(
      workerSsh,
      `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
        `cd ${quoteArg(ORIGIN)} && ` +
        `printf '%s' '{"name":"multi","scripts":{"start":"node s.js"}}' > package.json && ` +
        `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("multi bonjour")).listen(p)' > s.js && ` +
        "git init -q -b main . && git config user.email e@x && git config user.name e && " +
        "git add -A && git commit -q -m init"
    );
    ok("dépôt source créé sur le worker (pas le manager)");
  } finally {
    disconnect(workerSsh);
  }

  await removeService(managerDocker, SERVICE_NAME);

  // ── service épinglé sur le worker ─────────────────────────────────────────
  const [proj] = await db
    .insert(projects)
    .values({ name: "multi" })
    .returning();
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

  console.log("    (build sur le worker, bascule Swarm via le manager…)");
  await runDeploy(ctx, { deploymentId: dep.id });

  const final = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep.id),
  });
  if (final?.status === "succeeded") {
    ok(`déploiement succeeded, image ${final.imageTag}`);
  } else {
    ko(`statut ${final?.status} — ${final?.errorMessage ?? ""}`);
  }

  // ── LE point du test : la task a-t-elle atterri sur le BON nœud ? ─────────
  //
  // Sans contrainte de placement, Swarm aurait pu la planifier N'IMPORTE OÙ —
  // et sans registre, l'image construite sur le worker n'existe QUE là.
  const tasks = (await managerDocker.listTasks({
    filters: JSON.stringify({ service: [SERVICE_NAME] }),
  })) as Array<{ NodeID?: string; Status?: { State?: string } }>;
  const [workerNode] = workerNodes;
  const running = tasks.find((t) => t.Status?.State === "running");

  if (running && workerNode && running.NodeID === workerNode.ID) {
    ok("la task tourne sur le NŒUD WORKER — la contrainte de placement tient");
  } else {
    ko(
      `task sur le nœud ${running?.NodeID ?? "?"}, attendu ${workerNode?.ID ?? "?"}`
    );
  }

  // ── HTTP à travers le réseau overlay, depuis le manager ───────────────────
  //
  // Traefik écoute en `mode=host` sur le MANAGER uniquement (spike-local.sh,
  // `--constraint 'node.role==manager'`) : il faut donc dialoguer avec l'IP du
  // manager, jamais celle du worker, même si le domaine sslip.io du service
  // encode l'IP du worker. `fetch` ne peut pas fournir l'en-tête Host attendu
  // par la règle Traefik — c'est un en-tête interdit par la spec, déjà noté
  // dans CLAUDE.md — donc `curl -H` en sous-processus, pas `fetch`.
  let body = "";
  const httpDeadline = Date.now() + 90_000;
  while (Date.now() < httpDeadline) {
    // biome-ignore lint/performance/noAwaitInLoops: réessai volontaire, le provider Swarm de Traefik scrute toutes les 15s
    const result = await execFileAsync(
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
    if (result?.stdout.trim()) {
      body = result.stdout.trim();
      break;
    }
    await sleep(3000);
  }

  if (body.includes("multi")) {
    ok(`HTTP à travers l'overlay, servi depuis le worker : « ${body} »`);
  } else {
    ko("pas de réponse HTTP dans les 90 s");
  }

  // ── rollback, dans cette même topologie ───────────────────────────────────
  //
  // Pas un à-côté : c'est le mécanisme dont dépend la surveillance
  // post-déploiement (watch.ts) pour rattraper un crash tardif — et ici, ni
  // le build ni le service ne vivent sur le manager. `redeployImage` doit
  // retrouver le MÊME nœud pour la contrainte de placement, sans reconstruire.
  if (final?.imageTag) {
    const { redeployImage } = await import("#deploy");
    await redeployImage(ctx, {
      imageTag: final.imageTag,
      serviceId: svc.id,
      trigger: "rollback",
    });

    const afterRollback = await db.query.deployments.findFirst({
      orderBy: (d, { desc }) => desc(d.createdAt),
      where: eq(deployments.serviceId, svc.id),
    });
    if (afterRollback?.status === "succeeded") {
      ok("rollback accepté, toujours dans le même cluster à 2 nœuds");
    } else {
      ko(`rollback : statut ${afterRollback?.status}`);
    }

    const tasksAfter = (await managerDocker.listTasks({
      filters: JSON.stringify({ service: [SERVICE_NAME] }),
    })) as Array<{ NodeID?: string; Status?: { State?: string } }>;
    const runningAfter = tasksAfter.find((t) => t.Status?.State === "running");
    if (runningAfter && workerNode && runningAfter.NodeID === workerNode.ID) {
      ok("après rollback, la task est TOUJOURS sur le nœud worker");
    } else {
      ko(`après rollback, nœud ${runningAfter?.NodeID ?? "?"}`);
    }
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (managerSsh) {
    try {
      const docker = dockerClient(managerSsh);
      if (!process.env.NODDLE_KEEP) {
        await removeService(docker, SERVICE_NAME);
      }
    } catch {
      // nettoyage au mieux
    }
    disconnect(managerSsh);
  }
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
