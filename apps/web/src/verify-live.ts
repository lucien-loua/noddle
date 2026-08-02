// Le dashboard face à un VRAI déploiement.
//
// C'est la seule chose que `verify.ts` ne couvre pas : là-bas, le worker est
// SIMULÉ — on publie soi-même sur Redis. Ici les trois processus sont réels et
// séparés, et la question posée est celle qu'aucun test ne posait encore :
//
//   la sortie de nixpacks et de buildx, produite sur une VM par un worker
//   Node, arrive-t-elle jusqu'au flux SSE d'un web Bun ?
//
// Prérequis : la VM Multipass, Postgres, Redis, migrations appliquées, et
// `bun run build` déjà passé.
//
//   node apps/worker/src/… non : bun run src/verify-live.ts
//
// Compte quelques minutes : le build est réel.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDatabase } from "@noddle/db";
import {
  account,
  deploymentLogs,
  deployments,
  environments,
  envVars,
  projects,
  servers,
  services,
  session,
  user,
} from "@noddle/db/schema";
import {
  encryptSecret,
  loadAppKey,
  secretContext,
} from "@noddle/shared/crypto";
import { Queue } from "bullmq";
import { desc, eq } from "drizzle-orm";
import IORedis from "ioredis";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const PORT = Number(process.env.PORT ?? 3312);
const BASE = `http://localhost:${PORT}`;
const SERVICE_NAME = "noddle-live";
const ORIGIN = "/opt/noddle-live-origin";

const EMAIL = "admin@noddle.test";
const PASSWORD = "un-mot-de-passe-assez-long";

/** Un build nixpacks réel prend des minutes, pas des secondes. */
const DEPLOY_TIMEOUT_MS = 8 * 60 * 1000;

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
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("noddle-deploy", { connection: redis });

let cookie = "";

async function call(
  path: string,
  init: RequestInit = {}
): Promise<{ body: string; response: Response }> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  }
  return { body: await response.text(), response };
}

const procs: ReturnType<typeof Bun.spawn>[] = [];
const repoRoot = new URL("../../..", import.meta.url).pathname;

async function waitForWeb(): Promise<boolean> {
  for (let i = 0; i < 120; i += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sondage volontaire du démarrage
      const r = await fetch(`${BASE}/api/auth/ok`);
      if (r.ok) {
        return true;
      }
    } catch {
      // pas encore prêt
    }
    await sleep(500);
  }
  return false;
}

async function cleanupDb(): Promise<void> {
  await db.delete(session);
  await db.delete(account);
  await db.delete(user);
  await db.delete(deploymentLogs);
  await db.delete(deployments);
  await db.delete(envVars);
  await db.delete(services);
  await db.delete(environments);
  await db.delete(projects);
  await db.delete(servers);
  await queue.obliterate({ force: true }).catch(() => {
    // file déjà vide
  });
}

try {
  await cleanupDb();

  // ── décor : dépôt source sur la cible ────────────────────────────────────
  //
  // Le binaire `ssh` plutôt que `@noddle/ssh-executor` : ce paquet tire
  // `dockerode`, et le web ne doit jamais le charger — même dans un script de
  // vérification, sinon la frontière ne veut plus rien dire. C'est du vrai SSH
  // avec clé, jamais `multipass exec`.
  const remoteScript = [
    `sudo rm -rf '${ORIGIN}'`,
    `sudo mkdir -p '${ORIGIN}'`,
    `sudo chown -R "$USER" '${ORIGIN}'`,
    `cd '${ORIGIN}'`,
    `printf '%s' '{"name":"live","scripts":{"start":"node s.js"}}' > package.json`,
    `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("live "+(process.env.GREETING||"?"))).listen(p)' > s.js`,
    "git init -q -b main .",
    "git config user.email e@x",
    "git config user.name e",
    "git add -A",
    "git commit -q -m init",
  ].join(" && ");

  const seed = Bun.spawnSync([
    "ssh",
    "-i",
    KEY,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    `${USER}@${HOST}`,
    remoteScript,
  ]);
  if (seed.exitCode === 0) {
    ok("dépôt source créé sur la VM");
  } else {
    ko(`création du dépôt source : ${seed.stderr.toString().slice(0, 200)}`);
    throw new Error("abandon");
  }

  // ── décor : base ─────────────────────────────────────────────────────────
  const [srv] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "live-target",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
      totalMemoryMb: 2048,
    })
    .returning();
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        readFileSync(KEY, "utf8"),
        appKey,
        secretContext.serverSshKey(srv?.id ?? "")
      ),
    })
    .where(eq(servers.id, srv?.id ?? ""));

  const [proj] = await db.insert(projects).values({ name: "live" }).returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      domain: `${SERVICE_NAME}.${HOST.replaceAll(".", "-")}.sslip.io`,
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: `file://${ORIGIN}`,
      name: SERVICE_NAME,
      port: 3000,
      serverId: srv?.id ?? "",
      sourceType: "git",
    })
    .returning();
  const serviceId = svc?.id ?? "";
  ok("serveur et service enregistrés");

  // ── les trois processus, pour de vrai ────────────────────────────────────
  procs.push(
    Bun.spawn(["node", "src/index.ts"], {
      cwd: join(repoRoot, "apps/worker"),
      env: process.env,
      stderr: "pipe",
      stdout: "pipe",
    })
  );
  procs.push(
    Bun.spawn(["bun", "run", "server.ts"], {
      cwd: join(repoRoot, "apps/web"),
      env: { ...process.env, PORT: String(PORT) },
      stderr: "pipe",
      stdout: "pipe",
    })
  );

  if (await waitForWeb()) {
    ok("worker (Node) et web (Bun) démarrés, deux processus distincts");
  } else {
    ko("le web n'a pas démarré");
    throw new Error("abandon");
  }

  await call("/api/auth/sign-up/email", {
    body: JSON.stringify({ email: EMAIL, name: "admin", password: PASSWORD }),
    method: "POST",
  });
  if (cookie.length > 0) {
    ok("administrateur créé et connecté");
  } else {
    ko("connexion impossible");
    throw new Error("abandon");
  }

  // ── LE test : un déploiement réel, observé par le dashboard ──────────────
  const [dep] = await db
    .insert(deployments)
    .values({ serviceId, status: "queued", trigger: "manual" })
    .returning();
  const deploymentId = dep?.id ?? "";

  // Le flux est ouvert AVANT que le job parte : c'est ce que fait le bouton
  // Déployer, qui navigue vers le flux dès que la server function répond.
  const controller = new AbortController();
  const streamed = fetch(`${BASE}/api/logs/${deploymentId}`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });

  await queue.add("deploy", { deploymentId, kind: "deploy" });
  ok("job déposé — build réel en cours, quelques minutes…");

  const response = await streamed;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let received = "";
  let ended = false;

  const pump = (async () => {
    while (reader) {
      // biome-ignore lint/performance/noAwaitInLoops: pompe de flux, séquentielle par nature
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      received += decoder.decode(chunk.value, { stream: true });
      if (received.includes("event: end")) {
        ended = true;
        return;
      }
    }
  })().catch(() => {
    // flux coupé
  });

  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  while (!ended && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: attente du build réel
    await sleep(2000);
  }
  controller.abort();
  await pump;

  if (ended) {
    ok("le flux SSE s'est fermé de lui-même sur le message de fin");
  } else {
    ko("aucun message de fin reçu avant expiration");
  }

  // Ce que le dashboard a RÉELLEMENT reçu, et qui vient de la VM.
  const markers: [string, string][] = [
    ["▸ build plafonné à", "le plafond de build annoncé par le worker"],
    ["nixpacks", "la sortie de nixpacks"],
    ["#", "la sortie de buildx (--progress=plain)"],
    ["▸ bascule Swarm", "la bascule Swarm"],
    ["✓ déploiement accepté", "l'acceptation du déploiement"],
  ];
  for (const [needle, label] of markers) {
    if (received.includes(needle)) {
      ok(`${label} est arrivé jusqu'au dashboard`);
    } else {
      ko(`${label} manque dans le flux`);
    }
  }

  console.log(`\n  (${received.length} octets de SSE reçus par le web)\n`);

  // ── l'état que le dashboard affiche ──────────────────────────────────────
  const row = await db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
  });
  if (row?.status === "succeeded" && row.imageTag) {
    ok(`déploiement succeeded, image ${row.imageTag}`);
  } else {
    ko(`statut ${row?.status}, erreur : ${row?.errorMessage ?? "—"}`);
  }

  {
    const { body } = await call("/");
    if (body.includes(SERVICE_NAME) && body.includes("En service")) {
      ok("le dashboard affiche le service en service");
    } else {
      ko("le dashboard ne montre pas le service comme en service");
    }
  }

  // ── rollback : rejouer une image depuis l'historique ─────────────────────
  if (row?.imageTag) {
    await queue.add("rollback", {
      imageTag: row.imageTag,
      kind: "rollback",
      serviceId,
    });

    const rollbackDeadline = Date.now() + 3 * 60 * 1000;
    let replayed: typeof row | undefined;
    while (Date.now() < rollbackDeadline) {
      // biome-ignore lint/performance/noAwaitInLoops: sondage du rollback
      const latest = await db.query.deployments.findFirst({
        orderBy: desc(deployments.createdAt),
        where: eq(deployments.serviceId, serviceId),
      });
      if (latest && latest.id !== deploymentId && latest.finishedAt) {
        replayed = latest;
        break;
      }
      await sleep(3000);
    }

    if (replayed?.status === "succeeded" && replayed.trigger === "rollback") {
      ok("rollback : l'image de l'historique a été rejouée sans rebuild");
    } else {
      ko(`rollback : statut ${replayed?.status ?? "aucun déploiement"}`);
    }
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const p of procs) {
    p.kill();
  }
  await queue.close();
  await redis.quit();
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
