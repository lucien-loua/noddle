// L'installateur enregistre SA PROPRE machine comme serveur cible n°1.
//
// Le mono-machine est le cas courant, pas l'exception. Mais la cible locale
// passe par l'exécuteur SSH comme n'importe quelle autre : pas de branche
// `localhost`, pas de chemin de code privilégié. Conséquence voulue — le
// chemin de bouclage est exercé par TOUS les utilisateurs mono-machine, donc
// il ne peut pas pourrir sans que quelqu'un s'en aperçoive.
//
//   DATABASE_URL=… APP_KEY=… HOST_IP=… HOST_USER=… HOST_SSH_KEY=… \
//     node src/adopt-host.ts
//
// Idempotent : relancer l'installateur ne crée pas un second serveur.
import { readFileSync } from "node:fs";
import { createDatabase } from "@noddle/db";
import { servers } from "@noddle/db/schema";
import {
  encryptSecret,
  loadAppKey,
  secretContext,
} from "@noddle/shared/crypto";
import { and, eq } from "drizzle-orm";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`variable d'environnement requise : ${name}`);
  }
  return value;
}

const db = createDatabase({ url: required("DATABASE_URL") });
const appKey = loadAppKey(process.env.APP_KEY);

const host = required("HOST_IP");
const user = required("HOST_USER");
const port = Number(process.env.HOST_SSH_PORT ?? 22);
const privateKey = readFileSync(required("HOST_SSH_KEY"), "utf8");

// L'unicité est (hôte, port, utilisateur) en base ; on interroge la même
// combinaison plutôt qu'un drapeau, pour que réinstaller par-dessus une
// installation existante retombe sur la même ligne.
const existing = await db.query.servers.findFirst({
  where: and(
    eq(servers.host, host),
    eq(servers.sshPort, port),
    eq(servers.sshUser, user)
  ),
});

if (existing) {
  // La clé peut avoir été régénérée : on la réécrit, liée au MÊME identifiant.
  //
  // `role: "manager"` est réécrit ici aussi, et pas seulement à la création :
  // c'est `isSelf`, une colonne d'affichage, qui reste la source de vérité
  // sur « quelle machine a lancé l'installateur ». `role` porte le fait
  // d'orchestration — deux colonnes indépendantes qui, en Phase 2, décrivent
  // TOUJOURS la même ligne, parce que cette machine est la seule à avoir
  // exécuté `docker swarm init`, jamais parce que l'une serait déduite de
  // l'autre.
  await db
    .update(servers)
    .set({
      isSelf: true,
      role: "manager",
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(existing.id)
      ),
    })
    .where(eq(servers.id, existing.id));
  process.stdout.write(`serveur n°1 déjà enregistré (${existing.id})\n`);
} else {
  // L'AAD lie le chiffré à la LIGNE : il faut donc l'identifiant avant de
  // chiffrer, d'où l'insertion en deux temps.
  const [created] = await db
    .insert(servers)
    .values({
      host,
      isSelf: true,
      name: process.env.HOST_NAME ?? "cette machine",
      role: "manager",
      sshPort: port,
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: user,
    })
    .returning();
  if (!created) {
    throw new Error("enregistrement du serveur impossible");
  }
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(created.id)
      ),
    })
    .where(eq(servers.id, created.id));
  process.stdout.write(`serveur n°1 enregistré (${created.id})\n`);
}

process.exit(0);
