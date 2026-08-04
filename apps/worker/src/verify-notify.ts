// L'émission côté worker, contre un vrai Postgres et un vrai récepteur HTTP.
//
//   node apps/worker/src/verify-notify.ts
//
// `packages/notifier` prouve déjà l'ENVOI. Ce qui reste à prouver est le
// câblage, et il porte trois décisions qu'un typecheck ne voit pas :
//
//   · un canal désactivé ne reçoit rien ;
//   · un SUCCÈS n'atteint que les canaux qui l'ont demandé — sinon le canal
//     devient du bruit et personne ne le lit le jour où il porte un échec ;
//   · un canal en panne enregistre sa cause ET ne fait pas échouer l'appelant.
//     C'est le point qui compte : un envoi qui échoue en silence est pire que
//     pas de notification, on se croit surveillé.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createDatabase } from "@noddle/db";
import { notificationChannels } from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import { eq } from "drizzle-orm";
import { notify } from "#notify";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";

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
const ctx = {
  appKey,
  db,
  logRoot: "/tmp/noddle-notify-logs",
  networkName: "noddle-public",
};

let hits = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits += 1;
    res.writeHead(204).end();
  });
});
await new Promise<void>((r) => {
  server.listen(0, "127.0.0.1", () => r());
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const receiver = `http://127.0.0.1:${port}/`;

async function addChannel(opts: {
  enabled?: boolean;
  name: string;
  notifySuccess?: boolean;
  url: string;
}): Promise<string> {
  const [row] = await db
    .insert(notificationChannels)
    .values({
      enabled: opts.enabled ?? true,
      kind: "webhook",
      name: opts.name,
      notifySuccess: opts.notifySuccess ?? false,
      urlEncrypted: "placeholder",
    })
    .returning();
  const id = row?.id ?? "";
  // Le chiffrement est lié à l'id de la ligne (AAD) : elle doit exister avant.
  await db
    .update(notificationChannels)
    .set({
      urlEncrypted: encryptSecret(
        opts.url,
        appKey,
        secretContext.notificationChannel(id)
      ),
    })
    .where(eq(notificationChannels.id, id));
  return id;
}

console.log(
  "\n\x1b[1mÉmission des notifications — Postgres + HTTP réels\x1b[0m"
);

await db.delete(notificationChannels);

try {
  const live = await addChannel({ name: "actif", url: receiver });
  const off = await addChannel({
    enabled: false,
    name: "coupe",
    url: receiver,
  });

  // ── 1. Un échec atteint le canal actif, une seule fois ────────────────────
  hits = 0;
  await notify(ctx, {
    detail: "exit 1",
    resource: "api",
    type: "deploy_failed",
  });
  if (hits === 1) {
    ok("un échec atteint le canal actif, et lui seul (canal coupé ignoré)");
  } else {
    ko(`${hits} envoi(s), attendu 1`);
  }

  const after = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, live),
  });
  if (after?.lastSuccessAt && !after.lastError) {
    ok("la réussite est horodatée sur le canal");
  } else {
    ko(`lastSuccessAt=${after?.lastSuccessAt} lastError=${after?.lastError}`);
  }

  const offRow = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, off),
  });
  if (offRow?.lastSuccessAt) {
    ko("le canal désactivé a reçu un envoi");
  } else {
    ok("le canal désactivé n'a rien reçu");
  }

  // ── 2. Un SUCCÈS n'atteint que ceux qui l'ont demandé ────────────────────
  hits = 0;
  await notify(ctx, { resource: "api", type: "deploy_succeeded" });
  if (hits === 0) {
    ok("un succès n'atteint pas un canal qui ne l'a pas demandé");
  } else {
    ko(`un succès a été envoyé à ${hits} canal/canaux non demandeurs`);
  }

  await addChannel({ name: "verbeux", notifySuccess: true, url: receiver });
  hits = 0;
  await notify(ctx, { resource: "api", type: "deploy_succeeded" });
  if (hits === 1) {
    ok("un succès atteint le canal qui l'a demandé");
  } else {
    ko(`${hits} envoi(s) pour un succès, attendu 1`);
  }

  // ── 3. Un canal en panne : cause enregistrée, appelant épargné ───────────
  await db.delete(notificationChannels);
  const broken = await addChannel({
    name: "casse",
    url: "https://hote-inexistant.invalid/x",
  });

  let threw = false;
  try {
    await notify(ctx, { resource: "api", type: "deploy_failed" });
  } catch {
    threw = true;
  }
  if (threw) {
    ko("notify a levé — un canal cassé ferait échouer le déploiement");
  } else {
    ok("notify ne lève pas quand un canal est injoignable");
  }

  const brokenRow = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, broken),
  });
  if (brokenRow?.lastError) {
    ok(`la panne est enregistrée : ${brokenRow.lastError.slice(0, 45)}`);
  } else {
    ko("aucune cause enregistrée — la panne serait invisible");
  }

  // ── 4. Une panne suivie d'une réussite efface l'erreur ───────────────────
  // Sinon l'écran afficherait indéfiniment une erreur résolue depuis, et on
  // finirait par ignorer l'indicateur.
  await db
    .update(notificationChannels)
    .set({
      urlEncrypted: encryptSecret(
        receiver,
        appKey,
        secretContext.notificationChannel(broken)
      ),
    })
    .where(eq(notificationChannels.id, broken));
  await notify(ctx, { resource: "api", type: "deploy_failed" });
  const healed = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, broken),
  });
  if (healed?.lastError === null && healed.lastSuccessAt) {
    ok("une réussite efface l'erreur précédente");
  } else {
    ko(`erreur non effacée : ${healed?.lastError}`);
  }
} catch (err) {
  ko(`exception : ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await db.delete(notificationChannels);
  server.close();
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
