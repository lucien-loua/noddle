// Bout en bout : de la base jusqu'à une URL qui répond.
//
// C'est la seule chose que les vérifications par paquet ne couvraient pas.
// Chaque pièce marchait isolément ; personne n'avait encore enchaîné
// base → déchiffrement → SSH → clone → build capé → Swarm → Traefik → HTTP.
//
//   DATABASE_URL=… node apps/worker/src/verify-e2e.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@noddle/db";
import {
  deploymentLogs,
  deployments,
  environments,
  envVars,
  projects,
  servers,
  services,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import { connect, disconnect, exec, quoteArg } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { runDeploy } from "#deploy";
import { removeService } from "#swarm";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const SERVICE_NAME = "noddle-e2e";
const ORIGIN = "/opt/noddle-e2e-origin";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  [32m✓[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  [31m✗[0m ${m}`);
};

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");
const domain = `${SERVICE_NAME}.${HOST.replaceAll(".", "-")}.sslip.io`;

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

try {
  ssh = await connect({ host: HOST, privateKey, user: USER });

  // Dépôt source sur la cible. file:// est un transport inerte, admis par la
  // liste blanche ; ext:: ne l'est pas, et c'est le point.
  await exec(
    ssh,
    `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
      `cd ${quoteArg(ORIGIN)} && ` +
      `printf '%s' '{"name":"e2e","scripts":{"start":"node s.js"}}' > package.json && ` +
      `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("e2e "+(process.env.GREETING||"?"))).listen(p)' > s.js && ` +
      "git init -q -b main . && git config user.email e@x && git config user.name e && " +
      "git add -A && git commit -q -m init"
  );
  ok("dépôt source créé sur la cible");

  // ── seed ────────────────────────────────────────────────────────────────
  const [srv] = await db
    .insert(servers)
    .values({
      host: HOST,
      isSelf: false,
      name: "e2e-target",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
      totalMemoryMb: 2048,
    })
    .returning();
  if (!srv) {
    throw new Error("insertion serveur échouée");
  }
  // L'AAD lie le chiffré à CET identifiant : il faut donc l'id avant de chiffrer.
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(srv.id)
      ),
    })
    .where(eq(servers.id, srv.id));
  ok("serveur enregistré, clé SSH chiffrée avec liaison AAD");

  const [proj] = await db.insert(projects).values({ name: "e2e" }).returning();
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
      serverId: srv.id,
      sourceType: "git",
    })
    .returning();
  if (!svc) {
    throw new Error("insertion service échouée");
  }

  const [ev] = await db
    .insert(envVars)
    .values({
      isSecret: false,
      key: "GREETING",
      serviceId: svc.id,
      valueEncrypted: "placeholder",
    })
    .returning();
  await db
    .update(envVars)
    .set({
      valueEncrypted: encryptSecret(
        "bonjour",
        appKey,
        secretContext.envVar(ev?.id ?? "")
      ),
    })
    .where(eq(envVars.id, ev?.id ?? ""));
  ok("service et variable d'environnement chiffrée enregistrés");

  await removeService(
    (await import("@noddle/ssh-executor")).dockerClient(ssh),
    SERVICE_NAME
  );

  // ── déploiement ─────────────────────────────────────────────────────────
  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep) {
    throw new Error("insertion déploiement échouée");
  }

  const logDir = await mkdtemp(join(tmpdir(), "noddle-e2e-logs-"));
  let streamed = 0;
  console.log("    (clone, build capé et bascule Swarm — quelques minutes…)");

  await runDeploy(
    {
      appKey,
      db,
      logRoot: logDir,
      networkName: "noddle-public",
      onLog: () => {
        streamed += 1;
      },
    },
    { deploymentId: dep.id }
  );

  // ── assertions ──────────────────────────────────────────────────────────
  const final = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep.id),
  });

  if (final?.status === "succeeded") {
    ok(`déploiement succeeded, swarm=${final.swarmUpdateState ?? "création"}`);
  } else {
    ko(`statut ${final?.status} — ${final?.errorMessage ?? ""}`);
  }
  if (final?.commitSha && /^[0-9a-f]{40}$/.test(final.commitSha)) {
    ok(`SHA résolu et persisté : ${final.commitSha.slice(0, 8)}`);
  } else {
    ko("SHA non persisté");
  }
  if (final?.imageTag) {
    ok(`image construite : ${final.imageTag}`);
  } else {
    ko("aucun tag d'image");
  }
  if (final?.watchUntil && final.watchUntil > new Date()) {
    ok("surveillance post-déploiement armée");
  } else {
    ko("watchUntil absent : les crashs tardifs ne seraient pas rattrapés");
  }
  if (streamed > 0) {
    ok(`${streamed} fragments de log streamés vers SSE`);
  } else {
    ko("aucun log streamé");
  }

  const logs = await db.query.deploymentLogs.findMany({
    where: eq(deploymentLogs.deploymentId, dep.id),
  });
  const [row] = logs;
  if (logs.length === 1 && row && row.byteSize > 0) {
    ok(
      `logs : 1 ligne en base, pointeur vers ${row.byteSize} octets sur disque`
    );
  } else {
    ko(`attendu exactement 1 pointeur de log, obtenu ${logs.length}`);
  }

  const svcAfter = await db.query.services.findFirst({
    where: eq(services.id, svc.id),
  });
  if (
    svcAfter?.status === "running" &&
    svcAfter.currentDeploymentId === dep.id
  ) {
    ok("service marqué running et pointant vers ce déploiement");
  } else {
    ko(`état du service inattendu : ${svcAfter?.status}`);
  }

  // ── LA preuve : le service répond réellement ────────────────────────────
  // Via le domaine, PAS via un en-tête Host : `Host` est un en-tête interdit
  // pour fetch, silencieusement ignoré. sslip.io résout le domaine vers l'IP
  // qu'il encode, donc l'URL suffit.
  //
  // Et on réessaie : le provider Swarm de Traefik ne scrute que toutes les 15 s
  // par défaut. Une task convergée n'est donc PAS immédiatement joignable — un
  // fait produit, pas un artefact de test. Sur un premier déploiement,
  // « déployé » et « accessible » sont séparés par cette fenêtre.
  let body = "";
  const httpDeadline = Date.now() + 90_000;
  while (Date.now() < httpDeadline) {
    // Réessai volontaire : le provider Swarm de Traefik ne scrute que toutes
    // les 15 s, donc une task convergée n'est pas encore joignable.
    // biome-ignore lint/performance/noAwaitInLoops: réessai volontaire
    const res = await fetch(`http://${domain}/`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res?.ok) {
      body = (await res.text()).trim();
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (body.includes("e2e")) {
    ok(`HTTP via Traefik : « ${body} »`);
  } else {
    ko("pas de réponse via Traefik dans les 90 s");
  }
  if (body.includes("bonjour")) {
    ok("la variable chiffrée a été déchiffrée et injectée dans le conteneur");
  } else {
    ko("variable d'environnement absente du conteneur");
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (ssh) {
    try {
      // NODDLE_KEEP=1 laisse le service en place pour inspection.
      const { dockerClient } = await import("@noddle/ssh-executor");
      if (!process.env.NODDLE_KEEP) {
        await removeService(dockerClient(ssh), SERVICE_NAME);
      }
      await exec(ssh, `sudo rm -rf ${quoteArg(ORIGIN)}`);
    } catch {
      // nettoyage au mieux
    }
    disconnect(ssh);
  }
}

console.log(`\n[1mréussis ${pass}, échoués ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
