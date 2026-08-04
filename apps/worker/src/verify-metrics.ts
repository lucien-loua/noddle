// Collecte des ressources, contre une VRAIE VM et un vrai Postgres.
//
//   STACK_HOST=192.168.252.3 node apps/worker/src/verify-metrics.ts
//
// La question n'est pas « des lignes sont-elles écrites » mais « sont-elles
// VRAIES, et que se passe-t-il quand elles ne peuvent pas l'être ». Trois
// choses à prouver :
//
//   1. les valeurs relevées sont plausibles ET cohérentes avec la machine —
//      une mémoire utilisée supérieure au total, ou un disque à zéro, se
//      tracerait sans que personne ne le remarque ;
//   2. un serveur injoignable produit un TROU, jamais une ligne à zéro. Un
//      zéro se lit « la machine était calme », le contresens exact à éviter ;
//   3. l'échec d'un serveur n'empêche pas d'échantillonner les autres.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@noddle/db";
import {
  databases,
  serverMetrics,
  servers,
  serviceMetrics,
  services,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import { eq, inArray } from "drizzle-orm";
import { collectMetrics, cpuPercent, parseHostFacts } from "#metrics";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");
const DEAD = "192.0.2.1"; // TEST-NET-1 : garanti non routable

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

/**
 * Nettoyage.
 *
 * `databases.serverId` et `services.serverId` sont en `restrict`, pas en
 * `cascade` — supprimer une machine qui porte encore des données doit être
 * refusé. Le banc d'essai doit donc retirer les dépendants LUI-MÊME, ce que
 * la première exécution a appris à ses dépens : elle butait sur une base
 * laissée par une vérification précédente.
 */
async function reset(): Promise<void> {
  await db.delete(serviceMetrics);
  await db.delete(serverMetrics);
  const probes = await db.query.servers.findMany({
    where: inArray(servers.host, [HOST, DEAD]),
  });
  for (const s of probes) {
    // biome-ignore lint/performance/noAwaitInLoops: nettoyage séquentiel volontaire
    await db.delete(databases).where(eq(databases.serverId, s.id));
    await db.delete(services).where(eq(services.serverId, s.id));
  }
  await db.delete(servers).where(inArray(servers.host, [HOST, DEAD]));
}

await reset();

console.log(`\n\x1b[1mCollecte de ressources — VM ${HOST}\x1b[0m`);

try {
  // ── 1. L'analyse, sans réseau ────────────────────────────────────────────
  const parsed = parseHostFacts(
    "0.14 2 2002136 1587628 19682557952 7499407360"
  );
  if (
    parsed &&
    parsed.cpuCount === 2 &&
    parsed.memoryTotalBytes === 2_002_136 * 1024 &&
    parsed.memoryUsedBytes === (2_002_136 - 1_587_628) * 1024
  ) {
    ok("parseHostFacts lit la sortie réelle relevée sur la VM");
  } else {
    ko(`parseHostFacts : ${JSON.stringify(parsed)}`);
  }

  // Une sortie tronquée doit être REFUSÉE, pas complétée par des zéros.
  if (parseHostFacts("0.14 2 2002136") === null) {
    ok("une sortie tronquée est refusée plutôt que complétée par des zéros");
  } else {
    ko("une sortie tronquée a produit un échantillon");
  }

  // Un conteneur qui vient de démarrer n'a pas de delta système : on ne sait
  // pas, donc on ne trace pas. Zéro serait un mensonge lisible comme « inactif ».
  if (
    cpuPercent({
      cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 100 },
    }) === null
  ) {
    ok("un delta système nul ne produit pas 0 % mais rien du tout");
  } else {
    ko("un delta système nul a produit un pourcentage");
  }

  // ── 2. Une vraie collecte ────────────────────────────────────────────────
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "metrics-probe",
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

  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-metrics-logs",
    networkName: "noddle-public",
  };

  const first = await collectMetrics(ctx);
  if (first.servers === 1 && first.skipped.length === 0) {
    ok("le serveur joignable est échantillonné");
  } else {
    ko(`collecte : ${JSON.stringify(first)}`);
  }

  const [sample] = await db.query.serverMetrics.findMany({
    where: eq(serverMetrics.serverId, server.id),
  });
  if (!sample) {
    throw new Error("aucun échantillon écrit");
  }

  // Les valeurs doivent être COHÉRENTES, pas seulement présentes.
  const coherent =
    sample.memoryUsedBytes > 0 &&
    sample.memoryUsedBytes < sample.memoryTotalBytes &&
    sample.diskUsedBytes > 0 &&
    sample.diskUsedBytes < sample.diskTotalBytes &&
    sample.cpuCount >= 1 &&
    sample.cpuLoad1 >= 0;
  if (coherent) {
    const memPct = Math.round(
      (sample.memoryUsedBytes / sample.memoryTotalBytes) * 100
    );
    const diskPct = Math.round(
      (sample.diskUsedBytes / sample.diskTotalBytes) * 100
    );
    ok(
      `valeurs cohérentes : ${sample.cpuCount} cœurs, charge ${sample.cpuLoad1}, mém ${memPct} %, disque ${diskPct} %`
    );
  } else {
    ko(`valeurs incohérentes : ${JSON.stringify(sample)}`);
  }

  // La VM est provisionnée à 2 Go : si on lisait la mémoire de la MACHINE DE
  // DÉV au lieu de celle de la cible, ce test le verrait.
  const totalMb = Math.round(sample.memoryTotalBytes / 1024 / 1024);
  if (totalMb > 1500 && totalMb < 2500) {
    ok(`la mémoire relevée est celle de la VM (${totalMb} Mo), pas de l'hôte`);
  } else {
    ko(`mémoire relevée ${totalMb} Mo — est-ce bien la cible ?`);
  }

  // ── 3. Un serveur injoignable : un TROU, pas un zéro ────────────────────
  const [dead] = await db
    .insert(servers)
    .values({
      host: DEAD,
      name: "metrics-probe-mort",
      role: "worker",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!dead) {
    throw new Error("insertion serveur mort échouée");
  }
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(dead.id)
      ),
    })
    .where(eq(servers.id, dead.id));

  const second = await collectMetrics(ctx);
  const deadRows = await db.query.serverMetrics.findMany({
    where: eq(serverMetrics.serverId, dead.id),
  });
  if (deadRows.length === 0) {
    ok("un serveur injoignable n'écrit AUCUNE ligne — le trou reste un trou");
  } else {
    ko(`DANGER : ${deadRows.length} ligne(s) écrite(s) pour un serveur mort`);
  }
  if (second.skipped.includes(dead.id)) {
    ok("le serveur sauté est rapporté comme tel");
  } else {
    ko("le serveur injoignable n'est pas signalé");
  }
  if (second.servers === 1) {
    ok("l'échec d'un serveur n'empêche pas d'échantillonner l'autre");
  } else {
    ko(`${second.servers} serveur(s) échantillonné(s), attendu 1`);
  }
} catch (err) {
  ko(`exception : ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 4).join("\n"));
  }
} finally {
  await reset();
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
