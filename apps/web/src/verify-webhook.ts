// Webhook de déploiement, face à un VRAI push GitHub simulé.
//
// La question qu'aucun autre test ne pose : une requête HTTP signée, envoyée
// par un tiers sans session, déclenche-t-elle un déploiement RÉEL — et
// une signature fausse ou une branche différente sont-elles bien ignorées,
// sans jamais construire quoi que ce soit ?
//
// Prérequis : la VM Multipass, Postgres, Redis, migrations appliquées.
//
//   bun run src/verify-webhook.ts
//
// Compte quelques minutes : le build est réel.
import { createHmac } from "node:crypto";
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
import { eq } from "drizzle-orm";
import IORedis from "ioredis";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const PORT = Number(process.env.PORT ?? 3313);
const BASE = `http://localhost:${PORT}`;
const SERVICE_NAME = "noddle-webhook";
const ORIGIN = "/opt/noddle-webhook-origin";
const WEBHOOK_SECRET = "webhook-secret-de-test-1234567890";

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

const procs: ReturnType<typeof Bun.spawn>[] = [];
const repoRoot = new URL("../../..", import.meta.url).pathname;

function githubPush(ref: string, sha: string): string {
  return JSON.stringify({ after: sha, ref: `refs/heads/${ref}` });
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

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

  // ── décor : dépôt source sur la cible, comme verify-live.ts ───────────────
  const remoteScript = [
    `sudo rm -rf '${ORIGIN}'`,
    `sudo mkdir -p '${ORIGIN}'`,
    `sudo chown -R "$USER" '${ORIGIN}'`,
    `cd '${ORIGIN}'`,
    `printf '%s' '{"name":"webhook","scripts":{"start":"node s.js"}}' > package.json`,
    `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("webhook bonjour")).listen(p)' > s.js`,
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

  // Le SHA réel du HEAD : un webhook réel envoie le commit qu'il vient de
  // pousser, jamais une valeur inventée — `after` doit pointer vers quelque
  // chose que `git checkout` peut réellement trouver.
  const revParse = Bun.spawnSync([
    "ssh",
    "-i",
    KEY,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    `${USER}@${HOST}`,
    `git -C '${ORIGIN}' rev-parse HEAD`,
  ]);
  const headSha = revParse.stdout.toString().trim();

  // ── décor : base ─────────────────────────────────────────────────────────
  const [srv] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "webhook-target",
      role: "manager",
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

  const [proj] = await db
    .insert(projects)
    .values({ name: "webhook" })
    .returning();
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

  // Le secret est posé DIRECTEMENT ici, chiffré avec les mêmes primitives que
  // `generateServiceWebhook` — ce test vise le RÉCEPTEUR (signature, filtrage
  // de branche, dépôt du job), pas le formulaire de génération.
  await db
    .update(services)
    .set({
      webhookSecretEncrypted: encryptSecret(
        WEBHOOK_SECRET,
        appKey,
        secretContext.webhookSecret(serviceId)
      ),
    })
    .where(eq(services.id, serviceId));
  ok("serveur, service et secret webhook enregistrés");

  // ── les deux processus, pour de vrai ──────────────────────────────────────
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
    ok("worker et web démarrés");
  } else {
    ko("le web n'a pas démarré");
    throw new Error("abandon");
  }

  const path = `/api/webhooks/service/${serviceId}`;

  // ── signature fausse : refusée, RIEN ne se passe ──────────────────────────
  {
    const body = githubPush("main", "0000000000000000000000000000000000000a");
    const res = await fetch(`${BASE}${path}`, {
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=0000",
      },
      method: "POST",
    });
    if (res.status === 401) {
      ok("signature invalide refusée (401)");
    } else {
      ko(`signature invalide : statut ${res.status} au lieu de 401`);
    }
  }

  // ── branche différente : acceptée mais ignorée, aucun déploiement ────────
  {
    const before = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, serviceId),
    });
    const body = githubPush(
      "une-autre-branche",
      "0000000000000000000000000000000000000b"
    );
    const res = await fetch(`${BASE}${path}`, {
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
      },
      method: "POST",
    });
    const after = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, serviceId),
    });
    if (res.ok && after.length === before.length) {
      ok("branche différente : signature acceptée, déploiement ignoré");
    } else {
      ko(
        `branche différente : statut ${res.status}, ${after.length} déploiement(s) au lieu de ${before.length}`
      );
    }
  }

  // ── LE test : un push signé sur la bonne branche déploie pour de vrai ────
  const body = githubPush("main", headSha);
  const res = await fetch(`${BASE}${path}`, {
    body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
    },
    method: "POST",
  });
  const payload = (await res.json()) as { deploymentId?: string };
  if (res.ok && payload.deploymentId) {
    ok(`webhook accepté, déploiement ${payload.deploymentId} déposé`);
  } else {
    ko(`webhook : statut ${res.status}, corps ${JSON.stringify(payload)}`);
    throw new Error("abandon");
  }

  const { deploymentId } = payload;
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let final: typeof deployments.$inferSelect | undefined;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: attente du build réel
    const row = await db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
    });
    if (row?.finishedAt) {
      final = row;
      break;
    }
    await sleep(3000);
  }

  if (final?.trigger === "webhook" && final.status === "succeeded") {
    ok(
      `déploiement déclenché par webhook a convergé — image ${final.imageTag}`
    );
  } else {
    ko(
      `statut final ${final?.status ?? "jamais terminé"}, trigger ${final?.trigger ?? "—"}`
    );
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
