// Déploiement Compose : une VM réelle, deux services dans le MÊME fichier —
// un construit (`build:`), un pris tel quel (`image:`) — pour prouver les
// deux chemins de compose.ts contre du réel, pas seulement contre le
// typecheck. Le placement multi-nœud est déjà prouvé par verify-multi.ts ;
// ici la question est : `docker stack deploy` fait-il ce que compose.ts lui
// demande de faire, et le rollback rejoue-t-il vraiment une version passée
// sans toucher au dépôt ?
//
//   STACK_HOST=192.168.252.3 DATABASE_URL=… node apps/worker/src/verify-stack.ts
//
// Le manager doit DÉJÀ être en Swarm (n'importe quelle VM qui a servi à un
// test Phase 0/1/2 l'est).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createDatabase } from "@noddle/db";
import {
  environments,
  projects,
  servers,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import { connect, disconnect, dockerClient, exec } from "@noddle/ssh-executor";
import { eq, inArray } from "drizzle-orm";
import { redeployStack, runStackDeploy } from "#compose";
import { removeService } from "#swarm";

const execFileAsync = promisify(execFile);

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const STACK_HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const STACK_NAME = "noddle-stack-probe";
const ORIGIN = "/opt/noddle-stack-origin";
const domain = `${STACK_NAME}.${STACK_HOST.replaceAll(".", "-")}.sslip.io`;

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

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

// Rejouable : même principe que les autres verify.ts, l'index unique
// (host, port, user) collisionnerait sinon avec une exécution précédente.
await db.delete(stackDeployments);
await db.delete(stacks);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [STACK_HOST]));

const COMPOSE_CONTENT = `
services:
  web:
    build: ./web
    ports: []
  redis:
    image: redis:7-alpine
`;

const writeOrigin = async (
  ssh: Awaited<ReturnType<typeof connect>>,
  indexBody: string,
  message: string
) => {
  await exec(
    ssh,
    `mkdir -p ${ORIGIN}/web && cd ${ORIGIN} && ` +
      `cat > docker-compose.yml <<'EOF'\n${COMPOSE_CONTENT}\nEOF\n` +
      `cat > web/Dockerfile <<'EOF'\n` +
      "FROM python:3-alpine\nRUN apk add --no-cache curl\nWORKDIR /site\nCOPY index.html .\n" +
      'CMD ["python3", "-m", "http.server", "3000"]\n' +
      "EOF\n" +
      `printf '%s' ${JSON.stringify(indexBody)} > web/index.html && ` +
      "git init -q -b main . 2>/dev/null; git config user.email e@x && git config user.name e && " +
      `git add -A && git commit -q -m ${JSON.stringify(message)} --allow-empty`
  );
};

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: STACK_HOST,
      name: "stack-probe-manager",
      role: "manager",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("insertion serveur échouée");
  }
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(server.id)
      ),
    })
    .where(eq(servers.id, server.id));
  ok("serveur enregistré");

  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-stack-logs",
    networkName: "noddle-public",
  };

  managerSsh = await connect({ host: STACK_HOST, privateKey, user: USER });
  await removeService(dockerClient(managerSsh), `${STACK_NAME}_web`);
  await removeService(dockerClient(managerSsh), `${STACK_NAME}_redis`);

  await exec(
    managerSsh,
    `sudo rm -rf ${ORIGIN} && sudo mkdir -p ${ORIGIN} && sudo chown -R "$USER" ${ORIGIN}`
  );
  await writeOrigin(managerSsh, "compose bonjour un", "v1");
  ok("dépôt compose créé (build: web, image: redis)");

  const [proj] = await db
    .insert(projects)
    .values({ name: "stack-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [stack] = await db
    .insert(stacks)
    .values({
      domain,
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: `file://${ORIGIN}`,
      name: STACK_NAME,
      port: 3000,
      publicService: "web",
      serverId: server.id,
    })
    .returning();
  if (!stack) {
    throw new Error("insertion pile échouée");
  }

  const [dep1] = await db
    .insert(stackDeployments)
    .values({ stackId: stack.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep1) {
    throw new Error("insertion déploiement échouée");
  }

  console.log("    (v1 : build de web, image de redis, docker stack deploy…)");
  await runStackDeploy(ctx, { stackDeploymentId: dep1.id });

  const dep1Final = await db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, dep1.id),
  });
  if (dep1Final?.status === "succeeded") {
    ok(
      `v1 succeeded — services construits : ${JSON.stringify(dep1Final.serviceImages)}`
    );
  } else {
    ko(`v1 : statut ${dep1Final?.status} — ${dep1Final?.errorMessage ?? ""}`);
  }

  const builtOnlyWeb =
    dep1Final?.serviceImages &&
    Object.keys(dep1Final.serviceImages).length === 1 &&
    "web" in dep1Final.serviceImages;
  if (builtOnlyWeb) {
    ok("redis n'a PAS été construit — il n'a que `image:`, pas `build:`");
  } else {
    ko(`serviceImages inattendu : ${JSON.stringify(dep1Final?.serviceImages)}`);
  }

  if (dep1Final?.composeSource?.includes("build: ./web")) {
    ok(
      "composeSource stocké est le texte AVANT réécriture (build: encore présent)"
    );
  } else {
    ko("composeSource ne contient pas le build: original");
  }

  const managerDocker = dockerClient(managerSsh);
  const webSvc = (
    await managerDocker.listServices({
      filters: JSON.stringify({ name: [`${STACK_NAME}_web`] }),
    })
  ).find((s) => s.Spec?.Name === `${STACK_NAME}_web`);
  const redisSvc = (
    await managerDocker.listServices({
      filters: JSON.stringify({ name: [`${STACK_NAME}_redis`] }),
    })
  ).find((s) => s.Spec?.Name === `${STACK_NAME}_redis`);
  if (webSvc && redisSvc) {
    ok("les deux services Swarm existent (web ET redis)");
  } else {
    ko(
      `services manquants — web=${Boolean(webSvc)} redis=${Boolean(redisSvc)}`
    );
  }

  // ── HTTP à travers Traefik ─────────────────────────────────────────────────
  const httpOnce = async (): Promise<string> => {
    let body = "";
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: réessai volontaire, le provider Swarm de Traefik scrute toutes les 15s
      const result = await execFileAsync(
        "curl",
        [
          "-fsS",
          "--max-time",
          "10",
          "-H",
          `Host: ${domain}`,
          `http://${STACK_HOST}/`,
        ],
        { timeout: 12_000 }
      ).catch(() => null);
      if (result?.stdout.trim()) {
        body = result.stdout.trim();
        break;
      }
      await sleep(3000);
    }
    return body;
  };

  const body1 = await httpOnce();
  if (body1.includes("compose bonjour un")) {
    ok(`HTTP v1 via Traefik : « ${body1} »`);
  } else {
    ko(`pas de v1 dans les 90s (reçu : « ${body1} »)`);
  }

  // ── v2 : nouveau contenu, nouveau déploiement ──────────────────────────────
  await writeOrigin(managerSsh, "compose bonjour deux", "v2");
  const [dep2] = await db
    .insert(stackDeployments)
    .values({ stackId: stack.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep2) {
    throw new Error("insertion déploiement v2 échouée");
  }
  console.log("    (v2 : nouveau contenu…)");
  await runStackDeploy(ctx, { stackDeploymentId: dep2.id });

  const body2 = await httpOnce();
  if (body2.includes("compose bonjour deux")) {
    ok(`HTTP v2 via Traefik : « ${body2} »`);
  } else {
    ko(`pas de v2 dans les 90s (reçu : « ${body2} »)`);
  }

  // ── rollback vers v1, SANS dépôt ni build ─────────────────────────────────
  console.log("    (rollback vers v1 — rejoue composeSource + tags stockés…)");
  const rollbackId = await redeployStack(ctx, {
    sourceDeploymentId: dep1.id,
    stackId: stack.id,
    trigger: "rollback",
  });
  const rollbackFinal = await db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, rollbackId),
  });
  if (rollbackFinal?.status === "succeeded") {
    ok("rollback accepté");
  } else {
    ko(`rollback : statut ${rollbackFinal?.status}`);
  }

  const body3 = await httpOnce();
  if (body3.includes("compose bonjour un")) {
    ok(`HTTP après rollback : de retour à v1 — « ${body3} »`);
  } else {
    ko(`après rollback, attendu v1, reçu « ${body3} »`);
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (managerSsh) {
    try {
      const docker = dockerClient(managerSsh);
      if (!process.env.NODDLE_KEEP) {
        await removeService(docker, `${STACK_NAME}_web`);
        await removeService(docker, `${STACK_NAME}_redis`);
      }
    } catch {
      // nettoyage au mieux
    }
    disconnect(managerSsh);
  }
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
