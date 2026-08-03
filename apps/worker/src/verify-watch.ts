// Vérifie la surveillance post-déploiement contre un VRAI service qui boucle.
//
// Le scénario est celui mesuré en Phase 0, celui que Swarm ne rattrape pas :
// une application qui converge, passe son healthcheck, laisse la fenêtre
// monitor s'écouler — puis meurt. À cet instant l'ancienne task est drainée,
// l'update est déjà rapporté « completed », et la restart policy relance
// l'image cassée indéfiniment. Disponibilité mesurée alors : 9/12.
//
// Ce test échoue si Noddle ne reprend pas la main.
//
//   DATABASE_URL=… node apps/worker/src/verify-watch.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
import { desc, eq } from "drizzle-orm";
import { type DeployContext, runDeploy } from "#deploy";
import { removeService } from "#swarm";
import { sweepWatch } from "#sweep";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const SERVICE_NAME = "noddle-watch";
const ORIGIN = "/opt/noddle-watch-origin";

// 70 s : franchement au-delà de la fenêtre monitor de 45 s, avec assez de marge
// pour que le crash ne retombe pas dedans par hasard — auquel cas on testerait
// le rollback de Swarm, pas la surveillance de Noddle.
const CRASH_AFTER_S = 70;

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
const step = (m: string) => console.log(`    ${m}`);

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

async function writeApp(
  client: Awaited<ReturnType<typeof connect>>,
  body: string,
  message: string
): Promise<void> {
  // printf '%s' : sans ça, printf interprète les échappements et coupe les
  // littéraux JavaScript en deux.
  await exec(
    client,
    `cd ${quoteArg(ORIGIN)} && printf '%s' ${quoteArg(body)} > s.js && ` +
      `git add -A && git commit -q -m ${quoteArg(message)}`
  );
}

try {
  ssh = await connect({ host: HOST, privateKey, user: USER });
  const docker = dockerClient(ssh);
  await removeService(docker, SERVICE_NAME);

  await exec(
    ssh,
    `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
      `cd ${quoteArg(ORIGIN)} && printf '%s' '{"name":"w","scripts":{"start":"node s.js"}}' > package.json && ` +
      "git init -q -b main . && git config user.email w@x && git config user.name w"
  );
  await writeApp(
    ssh,
    'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("SAINE")).listen(p)',
    "v1 saine"
  );
  ok("dépôt créé, version saine committée");

  // ── seed ────────────────────────────────────────────────────────────────
  const [srv] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "watch-target",
      role: "manager",
      sshPrivateKeyEncrypted: "x",
      sshUser: USER,
      totalMemoryMb: 2048,
    })
    .returning();
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(srv?.id ?? "")
      ),
    })
    .where(eq(servers.id, srv?.id ?? ""));

  const [proj] = await db
    .insert(projects)
    .values({ name: "watch" })
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

  const logRoot = await mkdtemp(join(tmpdir(), "noddle-watch-logs-"));
  const ctx: DeployContext = {
    appKey,
    db,
    logRoot,
    networkName: "noddle-public",
  };

  // ── déploiement 1 : saine ───────────────────────────────────────────────
  step("déploiement de la version saine (build, quelques minutes)…");
  const [d1] = await db
    .insert(deployments)
    .values({ serviceId: svc?.id ?? "", status: "queued", trigger: "manual" })
    .returning();
  await runDeploy(ctx, { deploymentId: d1?.id ?? "" });

  const dep1 = await db.query.deployments.findFirst({
    where: eq(deployments.id, d1?.id ?? ""),
  });
  if (dep1?.status === "succeeded" && dep1.imageTag) {
    ok(`v1 déployée : ${dep1.imageTag}`);
  } else {
    throw new Error(`v1 a échoué : ${dep1?.status} ${dep1?.errorMessage}`);
  }

  // ── déploiement 2 : converge puis meurt HORS fenêtre ────────────────────
  await writeApp(
    ssh,
    `const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("CASSEE")).listen(p);setTimeout(()=>process.exit(1),${CRASH_AFTER_S * 1000})`,
    "v2 crash tardif"
  );
  step(`déploiement de la version qui meurt à ${CRASH_AFTER_S}s…`);

  const [d2] = await db
    .insert(deployments)
    .values({ serviceId: svc?.id ?? "", status: "queued", trigger: "manual" })
    .returning();
  await runDeploy(ctx, { deploymentId: d2?.id ?? "" });

  const dep2 = await db.query.deployments.findFirst({
    where: eq(deployments.id, d2?.id ?? ""),
  });

  // Le point crucial : Swarm considère ce déploiement RÉUSSI. Le crash est
  // encore à venir, hors de sa fenêtre de surveillance.
  if (dep2?.status === "succeeded") {
    ok("v2 rapportée réussie par Swarm — le crash n'a pas encore eu lieu");
  } else {
    ko(
      `v2 attendue succeeded, obtenue ${dep2?.status} (${dep2?.errorMessage})`
    );
  }
  if (dep2?.watchUntil && dep2.watchUntil > new Date()) {
    ok("surveillance armée : c'est tout ce qui reste entre l'app et la boucle");
  } else {
    ko("watchUntil absent — rien ne rattraperait le crash");
  }

  // ── la boucle s'installe, puis on passe la surveillance ─────────────────
  step("attente de la boucle de crash puis passages de surveillance…");
  const deadline = Date.now() + 6 * 60 * 1000;
  let reverted = false;

  while (Date.now() < deadline && !reverted) {
    // biome-ignore lint/performance/noAwaitInLoops: sondage volontaire
    await new Promise((r) => setTimeout(r, 20_000));
    const result = await sweepWatch(ctx);
    if (result.reverted.length > 0) {
      reverted = true;
      ok("surveillance : boucle détectée et retour arrière déclenché");
    } else if (result.strandedServices.length > 0) {
      ko("détectée mais aucune version antérieure trouvée");
      break;
    }
  }
  if (!reverted) {
    ko("la boucle n'a pas été détectée dans les 6 minutes");
  }

  // ── assertions finales ──────────────────────────────────────────────────
  const dep2After = await db.query.deployments.findFirst({
    where: eq(deployments.id, d2?.id ?? ""),
  });
  if (dep2After?.status === "reverted_by_watch") {
    ok("v2 marquée reverted_by_watch — distincte d'un rolled_back de Swarm");
  } else {
    ko(`statut attendu reverted_by_watch, obtenu ${dep2After?.status}`);
  }

  const latest = await db.query.deployments.findFirst({
    orderBy: desc(deployments.createdAt),
    where: eq(deployments.serviceId, svc?.id ?? ""),
  });
  if (
    latest?.trigger === "watch_revert" &&
    latest.imageTag === dep1?.imageTag
  ) {
    ok(`image de v1 rejouée depuis l'historique : ${latest.imageTag}`);
  } else {
    ko(`retour arrière inattendu : ${latest?.trigger} / ${latest?.imageTag}`);
  }

  // ── la preuve : le service resert la version saine ──────────────────────
  const domain = `${SERVICE_NAME}.${HOST.replaceAll(".", "-")}.sslip.io`;
  let body = "";
  const httpDeadline = Date.now() + 90_000;
  while (Date.now() < httpDeadline) {
    // biome-ignore lint/performance/noAwaitInLoops: sondage volontaire
    const res = await fetch(`http://${domain}/`, {
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (res?.ok) {
      body = (await res.text()).trim();
      if (body === "SAINE") {
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (body === "SAINE") {
    ok("le service resert la version saine — la boucle est terminée");
  } else {
    ko(`le service sert « ${body || "rien"} » au lieu de SAINE`);
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (ssh) {
    try {
      if (!process.env.NODDLE_KEEP) {
        await removeService(dockerClient(ssh), SERVICE_NAME);
        await exec(ssh, `sudo rm -rf ${quoteArg(ORIGIN)}`);
      }
    } catch {
      // nettoyage au mieux
    }
    disconnect(ssh);
  }
}

console.log(`\n[1mréussis ${pass}, échoués ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
