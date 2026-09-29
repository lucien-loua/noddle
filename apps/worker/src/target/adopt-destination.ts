import { checkDestination } from "@noddle/backup";
import { encryptSecret, loadAppKey, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { s3Destinations } from "@noddle/db/schema";
import { s3DestinationCreateSchema } from "@noddle/shared/validation/backup";
import { devStack } from "@noddle/testing/dev-stack";
import { eq } from "drizzle-orm";

const DESTINATION_NAME = "Dev stack (RustFS)";
const DESTINATION_PREFIX = "dev-backups";

const stack = devStack();
const db = createDatabase({ url: stack.databaseUrl });
const appKey = loadAppKey(process.env.APP_KEY);

const destination = s3DestinationCreateSchema.parse({
  accessKeyId: stack.s3.accessKeyId,
  bucket: stack.s3.bucket,
  endpoint: stack.s3.endpoint,
  name: DESTINATION_NAME,
  prefix: DESTINATION_PREFIX,
  secretAccessKey: stack.s3.secretAccessKey,
});

await checkDestination(destination);

const existing = await db.query.s3Destinations.findFirst({
  where: eq(s3Destinations.name, destination.name),
});
const id = existing?.id ?? crypto.randomUUID();
const values = {
  accessKeyId: destination.accessKeyId,
  bucket: destination.bucket,
  endpoint: destination.endpoint,
  forcePathStyle: destination.forcePathStyle,
  name: destination.name,
  prefix: destination.prefix,
  region: destination.region,
  secretAccessKeyEncrypted: encryptSecret(
    destination.secretAccessKey,
    appKey,
    secretContext.backupDestination(id)
  ),
};

if (existing) {
  await db
    .update(s3Destinations)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(s3Destinations.id, id));
  process.stdout.write(`backup destination already registered (${id})\n`);
} else {
  await db.insert(s3Destinations).values({ id, ...values });
  process.stdout.write(`backup destination registered (${id})\n`);
}
process.stdout.write(
  `  ${destination.endpoint}/${destination.bucket}/${destination.prefix}\n`
);

process.exit(0);
