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
import { homedir, tmpdir } from "node:os";
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
  decryptSecret,
  encryptSecret,
  loadAppKey,
  secretContext,
} from "@noddle/shared/crypto";
import { Queue } from "bullmq";
import { eq, isNotNull } from "drizzle-orm";
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

/**
 * La charge utile d'une pull request GitHub, réduite à ce que le lecteur
 * regarde. `sameRepo=false` simule un fork : dépôts source et cible différents.
 */
function githubPr(
  action: string,
  number: number,
  sha: string,
  branch: string,
  sameRepo = true
): string {
  return JSON.stringify({
    action,
    number,
    pull_request: {
      base: { repo: { full_name: "moi/appli" } },
      head: {
        ref: branch,
        repo: { full_name: sameRepo ? "moi/appli" : "quelquun/appli" },
        sha,
      },
      number,
    },
  });
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

  // Deux variables sur le parent, dont un SECRET. Sans elles, l'assertion de
  // copie plus bas comparerait zéro à zéro et ne prouverait rien — c'est
  // exactement ce qu'elle faisait à sa première écriture. Or la copie
  // déchiffre puis RECHIFFRE sous un AAD différent (lié à la ligne) : cassée,
  // la prévisualisation mourrait au déploiement sur un secret illisible.
  const seededVars = [
    { isSecret: false, key: "PUBLIC_ONE", value: "visible-value" },
    { isSecret: true, key: "SECRET_TWO", value: "s3cr3t-value" },
  ];
  for (const v of seededVars) {
    // biome-ignore lint/performance/noAwaitInLoops: décor séquentiel, volontaire
    const [row] = await db
      .insert(envVars)
      .values({
        isSecret: v.isSecret,
        key: v.key,
        serviceId,
        valueEncrypted: "placeholder",
      })
      .returning();
    await db
      .update(envVars)
      .set({
        valueEncrypted: encryptSecret(
          v.value,
          appKey,
          secretContext.envVar(row?.id ?? "")
        ),
      })
      .where(eq(envVars.id, row?.id ?? ""));
  }

  // ── CONSTRUIRE avant de servir ───────────────────────────────────────────
  //
  // `server.ts` sert `dist/server/server.js`, pas les sources. Sans cette
  // étape, le banc démarre le bundle de la DERNIÈRE construction et teste donc
  // du code qui n'est plus celui du dépôt — en passant, puisqu'un vieux bundle
  // fonctionne très bien. Payé une fois : les scénarios de pull request
  // tombaient sur « payload non reconnu », le lecteur de PR n'existant pas
  // dans le bundle servi.
  const built = Bun.spawnSync(["bunx", "vite", "build"], {
    cwd: join(repoRoot, "apps/web"),
    env: process.env,
  });
  if (built.exitCode === 0) {
    ok("apps/web construit — le bundle servi est celui du dépôt");
  } else {
    ko(`vite build a échoué : ${built.stderr.toString().slice(-400)}`);
    throw new Error("abandon");
  }

  // ── les deux processus, pour de vrai ──────────────────────────────────────
  //
  // `LOG_ROOT` est posé EXPLICITEMENT. Le worker retombe sinon sur
  // `/var/lib/noddle/logs`, qui est le chemin de PRODUCTION — dans le
  // conteneur, où il est monté. Ici le worker tourne sur la machine de
  // développement, où `mkdir /var/lib/noddle` échoue en EACCES : le job de
  // déploiement mourait avant même d'ouvrir sa connexion SSH, et le banc
  // attendait huit minutes un build qui n'avait jamais commencé. Le script
  // dépendait d'une variable d'environnement ambiante qu'il ne posait pas.
  const workerEnv = {
    ...process.env,
    LOG_ROOT: join(tmpdir(), "noddle-verify-webhook-logs"),
  };

  procs.push(
    Bun.spawn(["node", "src/index.ts"], {
      cwd: join(repoRoot, "apps/worker"),
      env: workerEnv,
      stderr: "pipe",
      stdout: "pipe",
    })
  );
  procs.push(
    Bun.spawn(["bun", "run", "server.ts"], {
      cwd: join(repoRoot, "apps/web"),
      env: { ...workerEnv, PORT: String(PORT) },
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
  // ── prévisualisations par pull request ─────────────────────────────────
  //
  // Le MÊME webhook, l'autre événement. Ce qui compte ici n'est pas qu'une PR
  // déploie — c'est qu'un fork n'obtienne RIEN, et qu'un `synchronize`
  // retombe sur la même ligne au lieu d'en créer une seconde.
  const postPr = async (prPayload: string) => {
    const r = await fetch(`${BASE}${path}`, {
      body: prPayload,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(prPayload, WEBHOOK_SECRET),
      },
      method: "POST",
    });
    return {
      body: (await r.json()) as Record<string, unknown>,
      status: r.status,
    };
  };
  const previews = async () =>
    await db.query.services.findMany({
      where: isNotNull(services.previewOfServiceId),
    });

  // Un FORK : aucune prévisualisation, et surtout aucun secret dehors.
  {
    const before = (await previews()).length;
    const r = await postPr(githubPr("opened", 99, headSha, "feature/x", false));
    const after = (await previews()).length;
    // Le MOTIF, pas seulement « ignoré » : le lecteur de push répond lui aussi
    // `{ignored: …}` sur une charge utile qu'il ne reconnaît pas. La première
    // version de ce test passait par ce chemin-là, donc sans jamais exercer la
    // détection de fork — un vert qui ne prouvait rien.
    const reason = String(r.body.ignored ?? "");
    if (r.status === 200 && after === before && reason.includes("fork")) {
      ok(`PR de fork ignorée (${reason}) — rien de créé`);
    } else {
      ko(
        `fork : statut ${r.status}, motif « ${reason} », ${after} prévisualisation(s) au lieu de ${before}`
      );
    }
  }

  // Une PR ouverte depuis le MÊME dépôt : une prévisualisation naît.
  const opened = await postPr(githubPr("opened", 7, headSha, "feature/x"));
  const created = (await previews()).find((p) => p.prNumber === 7);
  if (opened.status === 200 && created) {
    ok(`PR 7 → prévisualisation ${created.name}, domaine ${created.domain}`);
  } else {
    ko(`PR 7 : statut ${opened.status}, corps ${JSON.stringify(opened.body)}`);
    throw new Error("abandon");
  }

  // Les variables du parent ont-elles SUIVI, secrets compris — et surtout,
  // les valeurs se DÉCHIFFRENT-elles sous le nouvel AAD ?
  {
    const copied = await db.query.envVars.findMany({
      where: eq(envVars.serviceId, created.id),
    });
    if (copied.length === seededVars.length) {
      ok(`les ${copied.length} variables du parent ont été copiées`);
    } else {
      ko(`${copied.length} variable(s) copiée(s) sur ${seededVars.length}`);
    }

    // LE test : une copie qui ne se déchiffre pas est pire qu'une copie
    // absente — le défaut n'apparaîtrait qu'au démarrage du conteneur.
    const wrong: string[] = [];
    for (const row of copied) {
      const expected = seededVars.find((v) => v.key === row.key);
      try {
        const value = decryptSecret(
          row.valueEncrypted,
          appKey,
          secretContext.envVar(row.id)
        );
        if (value !== expected?.value) {
          wrong.push(`${row.key} (valeur différente)`);
        }
      } catch {
        wrong.push(`${row.key} (illisible)`);
      }
    }
    if (wrong.length === 0 && copied.length > 0) {
      ok("chaque valeur se déchiffre sous l'AAD de SA nouvelle ligne");
    } else {
      ko(
        `valeurs illisibles ou fausses : ${wrong.join(", ") || "aucune copie"}`
      );
    }

    const secretCopied = copied.find((r) => r.key === "SECRET_TWO");
    if (secretCopied?.isSecret === true) {
      ok("le drapeau `isSecret` a suivi la copie");
    } else {
      ko("le drapeau `isSecret` n'a pas suivi");
    }
  }

  // `synchronize` : la MÊME ligne se redéploie, jamais une seconde.
  {
    const before = await previews();
    const r = await postPr(githubPr("synchronize", 7, headSha, "feature/x"));
    const after = await previews();
    if (r.status === 200 && after.length === before.length) {
      ok("synchronize → même prévisualisation redéployée, pas une seconde");
    } else {
      ko(
        `synchronize : ${after.length} prévisualisation(s) au lieu de ${before.length}`
      );
    }
  }

  // Une action qui ne change rien ne doit RIEN déclencher.
  {
    const before = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, created.id),
    });
    await postPr(githubPr("labeled", 7, headSha, "feature/x"));
    const after = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, created.id),
    });
    if (after.length === before.length) {
      ok("action `labeled` → aucun déploiement de plus");
    } else {
      ko(`labeled a déclenché ${after.length - before.length} déploiement(s)`);
    }
  }

  // `closed` : la prévisualisation est démontée.
  {
    const r = await postPr(githubPr("closed", 7, headSha, "feature/x"));
    if (r.status === 200 && r.body.destroyed) {
      ok("PR fermée → démontage déposé");
    } else {
      ko(`closed : statut ${r.status}, corps ${JSON.stringify(r.body)}`);
    }

    const gone = Date.now() + 120_000;
    let left = 1;
    while (Date.now() < gone) {
      // biome-ignore lint/performance/noAwaitInLoops: attente du démontage réel
      left = (await previews()).filter((p) => p.prNumber === 7).length;
      if (left === 0) {
        break;
      }
      await sleep(3000);
    }
    if (left === 0) {
      ok("la prévisualisation a disparu de la base");
    } else {
      ko("la prévisualisation est encore là après 120 s");
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
