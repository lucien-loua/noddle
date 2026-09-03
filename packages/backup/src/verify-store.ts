// tier: local
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { devStack } from "@noddle/testing/dev-stack";

import {
  backupObjectKey,
  checkDestination,
  deleteObject,
  downloadStream,
  objectExists,
  uploadStream,
} from "./store.ts";
import type { BackupDestination } from "./store.ts";

const ENDPOINT = devStack().s3.endpoint;
const ACCESS_KEY = devStack().s3.accessKeyId;
const SECRET_KEY = devStack().s3.secretAccessKey;
const BUCKET = devStack().s3.bucket;

const runtime =
  globalThis.Bun === undefined
    ? `Node ${process.version}`
    : `Bun ${globalThis.Bun.version}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \u001B[32m✓\u001B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \u001B[31m✗\u001B[0m ${m}`);
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

console.log(`\n\u001B[1m${runtime} — backup store on ${ENDPOINT}\u001B[0m`);

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
  const admin = new S3Client({
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    endpoint: ENDPOINT,
    forcePathStyle: true,
    region: "us-east-1",
  });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch {}

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
    ok(`distinct keys in the same second: ${keyA.split("/").pop()}`);
  } else {
    ko(`key collision: ${keyA} / ${keyB}`);
  }

  const keyNoPrefix = backupObjectKey({
    backupId: "cccc",
    databaseName: "ma-base",
    extension: "rdb",
    prefix: "",
    takenAt,
  });
  if (keyNoPrefix.startsWith("ma-base/")) {
    ok("an empty prefix does not produce a leading slash");
  } else {
    ko(`empty prefix mishandled: ${keyNoPrefix}`);
  }

  await checkDestination(destination);
  ok("checkDestination accepts valid credentials");

  try {
    await checkDestination({ ...destination, secretAccessKey: "mauvaise-cle" });
    ko("checkDestination accepted a wrong secret key");
  } catch {
    ok("checkDestination rejects a wrong secret key");
  }

  try {
    await checkDestination({ ...destination, bucket: "compartiment-absent" });
    ko("checkDestination accepted a missing bucket");
  } catch {
    ok("checkDestination rejects a missing bucket");
  }

  const key = backupObjectKey({
    backupId: randomBytes(4).toString("hex"),
    databaseName: "ma-base",
    extension: "dump",
    prefix: destination.prefix,
    takenAt: new Date(),
  });
  const size = await uploadStream(destination, key, Readable.from(source()));
  if (size === CHUNK * CHUNKS) {
    ok(`multipart upload: ${size} bytes re-read via HEAD`);
  } else {
    ko(`size re-read ${size}, expected ${CHUNK * CHUNKS}`);
  }

  if (await objectExists(destination, key)) {
    ok("objectExists finds the uploaded object");
  } else {
    ko("objectExists does not find the uploaded object");
  }

  const body = await downloadStream(destination, key);
  const hash = createHash("sha256");
  let read = 0;
  for await (const chunk of body) {
    read += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  if (hash.digest("hex") === expectedDigest() && read === CHUNK * CHUNKS) {
    ok("stream re-read: sha256 identical outbound and inbound");
  } else {
    ko(`divergent re-read: ${read} bytes`);
  }

  if (await objectExists(destination, `${key}-inexistant`)) {
    ko("objectExists claims a missing object exists");
  } else {
    ok("objectExists returns false for a missing object");
  }

  const brokenKey = `${key}-casse`;
  const exploding = function* exploding(): Generator<Buffer> {
    yield Buffer.alloc(CHUNK, 1);
    throw new Error("dumper killed mid-flight");
  };
  try {
    await uploadStream(destination, brokenKey, Readable.from(exploding()));
    ko("an exploding stream produced a successful upload");
  } catch {
    ok("an exploding stream fails the upload");
  }
  if (await objectExists(destination, brokenKey)) {
    ko("a ghost object remained after the failure");
  } else {
    ok("no object published after a broken stream");
  }

  await deleteObject(destination, key);
  if (await objectExists(destination, key)) {
    ko("the deleted object still exists");
  } else {
    ok("deleteObject actually removes the object");
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 4).join("\n"));
  }
}

console.log(
  `\n\u001B[1m${runtime} — passed ${pass}, failed ${fail}\u001B[0m\n`
);
process.exit(fail === 0 ? 0 : 1);
