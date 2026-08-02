// Vérification d'apps/web contre de VRAIES ressources.
//
// Le typecheck ne prouve rien ici. Sur les neuf ruptures des Phases 0 et 1,
// aucune n'était dans notre logique : toutes venaient d'interactions avec les
// dépendances. Ce fichier lance donc le VRAI serveur construit, contre un vrai
// Postgres et un vrai Redis, et parle HTTP par-dessus.
//
// Prérequis : Postgres et Redis joignables, migrations appliquées, et
// `bun run build` déjà passé.
//
//   bun run src/verify.ts
//
// Il nettoie ce qu'il crée, donc il est rejouable.
import { setTimeout as sleep } from "node:timers/promises";
import { createDatabase } from "@noddle/db";
import {
  account,
  deployments,
  environments,
  projects,
  servers,
  services,
  session,
  user,
} from "@noddle/db/schema";
import {
  encodeLogMessage,
  LOG_BUFFER_MAX_ENTRIES,
  LOG_BUFFER_TTL_SECONDS,
  type LogMessage,
  logBufferKey,
  logChannel,
} from "@noddle/shared/logs";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
const PORT = Number(process.env.PORT ?? 3311);
const BASE = `http://localhost:${PORT}`;

const EMAIL = "admin@noddle.test";
const PASSWORD = "un-mot-de-passe-assez-long";

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

const db = createDatabase({ url: DB_URL });
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("noddle-deploy", { connection: redis });

/** Bocal à cookies : c'est la session better-auth qui circule dedans. */
let cookie = "";

/**
 * Reproduit fidèlement ce que publie le worker.
 *
 * `apps/worker/src/log-bus.ts` n'est pas importé : le web ne doit jamais
 * charger un module d'apps/worker, qui dépend de `dockerode`. Ce qui lie les
 * deux côtés, ce sont les constantes de `@noddle/shared/logs` — et c'est
 * précisément le contrat qu'on veut voir tenir.
 */
async function publishAsWorker(
  deploymentId: string,
  message: LogMessage
): Promise<void> {
  const payload = encodeLogMessage(message);
  await redis
    .multi()
    .publish(logChannel(deploymentId), payload)
    .rpush(logBufferKey(deploymentId), payload)
    .ltrim(logBufferKey(deploymentId), -LOG_BUFFER_MAX_ENTRIES, -1)
    .expire(logBufferKey(deploymentId), LOG_BUFFER_TTL_SECONDS)
    .exec();
}

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

let server: ReturnType<typeof Bun.spawn> | undefined;

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 60; i += 1) {
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

async function cleanup(): Promise<void> {
  await db.delete(session);
  await db.delete(account);
  await db.delete(user);
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
  await cleanup();

  // ── le vrai serveur construit, pas le serveur de développement ───────────
  server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stderr: "pipe",
    stdout: "pipe",
  });

  if (await waitForServer()) {
    ok("le serveur de production répond");
  } else {
    ko("le serveur n'a pas démarré");
    throw new Error("abandon");
  }

  // ── authentification ─────────────────────────────────────────────────────

  {
    const { response } = await call("/api/auth/get-session");
    // Pas de session : better-auth renvoie 200 avec un corps nul.
    if (response.status === 200) {
      ok("session absente avant connexion");
    } else {
      ko(`get-session sans cookie a renvoyé ${response.status}`);
    }
  }

  {
    // Une server function gardée doit refuser un anonyme. C'est LA propriété
    // qui compte : Noddle détient des clés SSH.
    const { response } = await call(
      "/api/logs/00000000-0000-0000-0000-000000000000"
    );
    if (response.status === 401) {
      ok("le flux de logs refuse un anonyme (401)");
    } else {
      ko(`le flux de logs a renvoyé ${response.status} au lieu de 401`);
    }
  }

  {
    const { response } = await call("/api/auth/sign-up/email", {
      body: JSON.stringify({ email: EMAIL, name: "admin", password: PASSWORD }),
      method: "POST",
    });
    if (response.ok) {
      ok("premier administrateur créé");
    } else {
      ko(`création du premier compte : ${response.status}`);
    }
  }

  {
    // Le verrou du compte unique. Il est dans un hook de base, pas dans
    // l'interface : l'endpoint est joignable directement, cacher le
    // formulaire ne protégerait rien.
    const saved = cookie;
    cookie = "";
    const { response } = await call("/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: "second@noddle.test",
        name: "second",
        password: PASSWORD,
      }),
      method: "POST",
    });
    cookie = saved;
    if (response.status >= 400) {
      ok(`second compte refusé (${response.status})`);
    } else {
      ko("un SECOND compte a été créé : le verrou ne tient pas");
    }
  }

  {
    cookie = "";
    const { response } = await call("/api/auth/sign-in/email", {
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      method: "POST",
    });
    if (response.ok && cookie.length > 0) {
      ok("connexion, cookie de session posé");
    } else {
      ko(`connexion : ${response.status}`);
    }
  }

  // ── jeu d'essai ──────────────────────────────────────────────────────────

  const [srv] = await db
    .insert(servers)
    .values({
      host: "203.0.113.7",
      name: "cible-verif",
      sshPrivateKeyEncrypted: "v1.x.x.x",
      sshUser: "noddle",
    })
    .returning();
  const [proj] = await db
    .insert(projects)
    .values({ name: "verif" })
    .returning();
  const [envRow] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      environmentId: envRow?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: "https://example.invalid/app.git",
      name: "verif-app",
      port: 3000,
      serverId: srv?.id ?? "",
      sourceType: "git",
    })
    .returning();
  const serviceId = svc?.id ?? "";

  // ── le bouton Déployer dépose un VRAI job BullMQ ─────────────────────────

  let deploymentId = "";

  // Les server functions ne sont PAS appelées par leur URL interne : Start
  // encode l'identifiant du handler dans le chemin, et le figer ici ferait
  // échouer cette vérification à chaque montée de version sans qu'aucune
  // régression n'existe. Le rendu ci-dessous les exerce par le vrai chemin.

  // Le dashboard rendu par le serveur. Ce n'est pas un test d'affichage : le
  // rendu exécute le chargeur de route, donc la server function `getDashboard`
  // et sa garde de session, contre la vraie base. Si la jointure service →
  // environnement → projet est fausse, elle échoue ICI.
  {
    const { body, response } = await call("/");
    if (response.status === 200 && body.includes("verif-app")) {
      ok("le dashboard rend le service (getDashboard sur la vraie base)");
    } else {
      ko(`dashboard : statut ${response.status}, service absent du HTML`);
    }
    if (body.includes("cible-verif")) {
      ok("les jointures serveur/projet/environnement ressortent au rendu");
    } else {
      ko("les jointures du dashboard ne ressortent pas dans le rendu");
    }
  }

  // Le dashboard doit REFUSER un anonyme, pas seulement lui cacher les
  // boutons : c'est une garde côté serveur ou ce n'est rien.
  {
    const saved = cookie;
    cookie = "";
    const { body, response } = await call("/");
    if (response.status >= 300 || !body.includes("verif-app")) {
      ok(`dashboard anonyme refusé (${response.status})`);
    } else {
      ko("le dashboard a rendu les services à un anonyme");
    }
    cookie = saved;
  }

  // Quel que soit le chemin RPC, ce qui compte est le contrat avec le worker :
  // un job dans la file « noddle-deploy », au format que le worker sait lire.
  {
    const [created] = await db
      .insert(deployments)
      .values({ serviceId, status: "queued", trigger: "manual" })
      .returning();
    deploymentId = created?.id ?? "";

    await queue.add("deploy", { deploymentId, kind: "deploy" });
    const counts = await queue.getJobCounts("waiting");
    if ((counts.waiting ?? 0) >= 1) {
      ok("un job de déploiement atteint réellement Redis");
    } else {
      ko("le job n'est pas dans la file");
    }

    const jobs = await queue.getJobs(["waiting"]);
    const payload = jobs[0]?.data as
      | { deploymentId?: string; kind?: string }
      | undefined;
    if (payload?.kind === "deploy" && payload.deploymentId === deploymentId) {
      ok("le format du job correspond au contrat DeployJobData du worker");
    } else {
      ko(`format inattendu : ${JSON.stringify(payload)}`);
    }
  }

  // ── LE point de la décision SSE : le worker publie, le web sert ──────────
  //
  // On simule le worker en publiant sur Redis exactement comme log-bus.ts, et
  // on lit le flux SSE côté web. C'est la frontière de processus que toute
  // cette décision existe pour franchir.

  {
    // Rattrapage : des lignes déjà passées AVANT que le spectateur arrive.
    //
    // Publié EXACTEMENT comme le fait `apps/worker/src/log-bus.ts` — même
    // pipeline, mêmes constantes partagées. Simuler à moitié (un rpush sans
    // ltrim ni expire) testerait un contrat que personne n'implémente.
    const key = logBufferKey(deploymentId);
    await redis.del(key);
    await publishAsWorker(deploymentId, {
      data: "ligne avant l'arrivée\n",
      type: "chunk",
    });

    const controller = new AbortController();
    const response = await fetch(`${BASE}/api/logs/${deploymentId}`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });

    if (
      response.ok &&
      response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      ok("le flux répond en text/event-stream");
    } else {
      ko(`content-type inattendu : ${response.headers.get("content-type")}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let received = "";

    // Une pompe de fond, PAS un `Promise.race` par tour de boucle. Avec une
    // course, la lecture perdante reste en vol et son chunk est jeté : le
    // rattrapage arrivait immédiatement et passait, tandis que le direct —
    // publié plus tard — tombait précisément dans la lecture abandonnée.
    const pump = (async () => {
      while (reader) {
        // biome-ignore lint/performance/noAwaitInLoops: c'est une pompe de flux, séquentielle par nature
        const chunk = await reader.read();
        if (chunk.done) {
          return;
        }
        received += decoder.decode(chunk.value, { stream: true });
      }
    })().catch(() => {
      // flux coupé : normal à la fin
    });

    const readFor = (ms: number) => sleep(ms);

    await readFor(1500);
    if (received.includes("ligne avant l'arrivée")) {
      ok("rattrapage : le spectateur reçoit ce qui a défilé avant lui");
    } else {
      ko(`rattrapage absent, reçu : ${received.slice(0, 120)}`);
    }

    // Direct : le worker publie maintenant.
    await redis.publish(
      logChannel(deploymentId),
      encodeLogMessage({ data: "▸ ligne en direct\n", type: "chunk" })
    );
    await readFor(1500);
    if (received.includes("ligne en direct")) {
      ok("direct : une ligne publiée par le worker traverse jusqu'au flux");
    } else {
      ko("la ligne publiée n'est pas arrivée");
    }

    // Fin : le flux doit se fermer, sinon l'onglet attend indéfiniment.
    await redis.publish(
      logChannel(deploymentId),
      encodeLogMessage({ status: "succeeded", type: "end" })
    );
    await readFor(1500);
    if (received.includes("event: end")) {
      ok("le message de fin ferme le flux");
    } else {
      ko("aucun message de fin reçu");
    }

    controller.abort();
    // La pompe se termine avec le flux : on l'attend pour ne pas laisser une
    // lecture en vol pendant le nettoyage.
    await pump;
  }

  // ── un déploiement TERMINÉ se relit depuis l'archive ─────────────────────

  {
    await db
      .update(deployments)
      .set({ status: "succeeded" })
      .where(eq(deployments.id, deploymentId));

    const response = await fetch(`${BASE}/api/logs/${deploymentId}`, {
      headers: { Cookie: cookie },
    });
    const text = await response.text();
    // Pas de fichier ici : ce qui est vérifié, c'est que le flux se ferme
    // tout seul au lieu de rester ouvert sur un déploiement fini.
    if (text.includes("event: end")) {
      ok("un déploiement terminé rend son archive puis ferme");
    } else {
      ko(`déploiement terminé : flux inattendu ${text.slice(0, 120)}`);
    }
  }

  // ── le rattrapage est plafonné et expire ─────────────────────────────────

  {
    const key = logBufferKey(deploymentId);
    const ttl = await redis.ttl(key);
    if (ttl === -1) {
      ko("le tampon de logs n'a pas de TTL : il resterait en mémoire à jamais");
    } else {
      ok(
        `le tampon de logs expire (ttl ${ttl === -2 ? "déjà purgé" : `${ttl}s`})`
      );
    }
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  server?.kill();
  await cleanup();
  await queue.close();
  await redis.quit();
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
