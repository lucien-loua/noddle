// Vérifie le dépôt d'objets contre un VRAI stockage compatible S3.
//
// La cible de développement est RustFS, lancé en conteneur :
//
//   docker run -d --name rustfs -p 9000:9000 -p 9001:9001 \
//     -e RUSTFS_ACCESS_KEY=rustfsadmin -e RUSTFS_SECRET_KEY=rustfsadmin \
//     -e RUSTFS_VOLUMES=/data rustfs/rustfs:latest
//
//   bun  run packages/backup-store/src/verify.ts
//   node packages/backup-store/src/verify.ts
//
// Les deux runtimes, parce que le worker est sur Node et le web sur Bun : la
// destination est éprouvée depuis le formulaire, les dumps sont téléversés
// depuis le worker. Un SDK qui ne marcherait que d'un côté se verrait ici et
// pas en production.
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  type BackupDestination,
  backupObjectKey,
  checkDestination,
  deleteObject,
  downloadStream,
  objectExists,
  uploadStream,
} from "#index";

const ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "rustfsadmin";
const SECRET_KEY = process.env.S3_SECRET_KEY ?? "rustfsadmin";
const BUCKET = process.env.S3_BUCKET ?? "noddle-verify";

const runtime =
  typeof globalThis.Bun === "undefined"
    ? `Node ${process.version}`
    : `Bun ${globalThis.Bun.version}`;

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

const destination: BackupDestination = {
  accessKeyId: ACCESS_KEY,
  bucket: BUCKET,
  endpoint: ENDPOINT,
  forcePathStyle: true,
  prefix: "verif",
  region: "us-east-1",
  secretAccessKey: SECRET_KEY,
};

console.log(
  `\n\x1b[1m${runtime} — dépôt de sauvegardes sur ${ENDPOINT}\x1b[0m`
);

// 24 Mio : trois parts de 8 Mio, donc un multipart réel. Un objet d'un seul
// PUT ne prouverait rien du chemin qu'emprunte un vrai dump.
const CHUNK = 8 * 1024 * 1024;
const CHUNKS = 3;
const seed = randomBytes(CHUNK);

function* source(): Generator<Buffer> {
  for (let i = 0; i < CHUNKS; i += 1) {
    const buf = Buffer.from(seed);
    buf.writeUInt32BE(i, 0);
    yield buf;
  }
}

function expectedDigest(): string {
  const h = createHash("sha256");
  for (const c of source()) {
    h.update(c);
  }
  return h.digest("hex");
}

try {
  // Le compartiment est fourni par l'utilisateur en production ; ici on le
  // crée, donc ce n'est pas au paquet de savoir le faire.
  const admin = new S3Client({
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    endpoint: ENDPOINT,
    forcePathStyle: true,
    region: "us-east-1",
  });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch {
    // déjà présent : c'est le cas normal des exécutions suivantes
  }

  // ── 1. La clé porte l'id, pas seulement l'horodatage ──────────────────────
  const takenAt = new Date("2026-08-03T12:34:56.789Z");
  const keyA = backupObjectKey({
    backupId: "aaaa",
    databaseName: "ma-base",
    extension: "dump",
    prefix: "verif",
    takenAt,
  });
  const keyB = backupObjectKey({
    backupId: "bbbb",
    databaseName: "ma-base",
    extension: "dump",
    prefix: "verif",
    takenAt,
  });
  if (keyA !== keyB && keyA.startsWith("verif/ma-base/")) {
    ok(`clés distinctes à la même seconde : ${keyA.split("/").pop()}`);
  } else {
    ko(`collision de clé : ${keyA} / ${keyB}`);
  }

  const keyNoPrefix = backupObjectKey({
    backupId: "cccc",
    databaseName: "ma-base",
    extension: "rdb",
    prefix: "",
    takenAt,
  });
  if (keyNoPrefix.startsWith("ma-base/")) {
    ok("un préfixe vide ne produit pas de barre oblique de tête");
  } else {
    ko(`préfixe vide mal recollé : ${keyNoPrefix}`);
  }

  // ── 2. Identifiants valides : aller-retour complet ─────────────────────────
  await checkDestination(destination);
  ok("checkDestination accepte des identifiants valides");

  // ── 3. Identifiants faux : DOIT échouer ───────────────────────────────────
  // Un test de destination qui réussit toujours est pire qu'aucun test : il
  // fait croire à l'utilisateur qu'il est protégé.
  try {
    await checkDestination({ ...destination, secretAccessKey: "mauvaise-cle" });
    ko("checkDestination a accepté une clé secrète fausse");
  } catch {
    ok("checkDestination refuse une clé secrète fausse");
  }

  try {
    await checkDestination({ ...destination, bucket: "compartiment-absent" });
    ko("checkDestination a accepté un compartiment inexistant");
  } catch {
    ok("checkDestination refuse un compartiment inexistant");
  }

  // ── 4. Téléversement d'un flux sans longueur connue ───────────────────────
  const key = backupObjectKey({
    backupId: randomBytes(4).toString("hex"),
    databaseName: "ma-base",
    extension: "dump",
    prefix: destination.prefix,
    takenAt: new Date(),
  });
  const size = await uploadStream(destination, key, Readable.from(source()));
  if (size === CHUNK * CHUNKS) {
    ok(`téléversement multipart : ${size} octets relus par HEAD`);
  } else {
    ko(`taille relue ${size}, attendu ${CHUNK * CHUNKS}`);
  }

  if (await objectExists(destination, key)) {
    ok("objectExists trouve l'objet téléversé");
  } else {
    ko("objectExists ne trouve pas l'objet téléversé");
  }

  // ── 5. Relecture : l'octet, pas « ça a marché » ───────────────────────────
  const body = await downloadStream(destination, key);
  const hash = createHash("sha256");
  let read = 0;
  for await (const chunk of body) {
    read += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  if (hash.digest("hex") === expectedDigest() && read === CHUNK * CHUNKS) {
    ok("relecture en flux : sha256 identique à l'aller et au retour");
  } else {
    ko(`relecture divergente : ${read} octets`);
  }

  // ── 6. Un objet absent est absent, pas une exception à interpréter ────────
  if (await objectExists(destination, `${key}-inexistant`)) {
    ko("objectExists prétend qu'un objet absent existe");
  } else {
    ok("objectExists renvoie faux sur un objet absent");
  }

  // ── 7. Le flux casse en plein vol ─────────────────────────────────────────
  // Un pg_dump tué, une session SSH coupée. Mesuré : le SDK annule l'envoi
  // multipart et rien n'est publié — c'est ce qui autorise à ne PAS écrire de
  // code de nettoyage sur ce chemin.
  const brokenKey = `${key}-casse`;
  function* exploding(): Generator<Buffer> {
    yield Buffer.alloc(CHUNK, 1);
    throw new Error("dumper tué en plein vol");
  }
  try {
    await uploadStream(destination, brokenKey, Readable.from(exploding()));
    ko("un flux qui explose a produit un téléversement réussi");
  } catch {
    ok("un flux qui explose fait échouer le téléversement");
  }
  if (await objectExists(destination, brokenKey)) {
    ko("un objet fantôme est resté après l'échec");
  } else {
    ok("aucun objet publié après un flux cassé");
  }

  // ── 8. Suppression ────────────────────────────────────────────────────────
  await deleteObject(destination, key);
  if (await objectExists(destination, key)) {
    ko("l'objet supprimé existe encore");
  } else {
    ok("deleteObject retire réellement l'objet");
  }
} catch (err) {
  ko(`exception : ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 4).join("\n"));
  }
}

console.log(`\n\x1b[1m${runtime} — réussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
