// bun run packages/testing/src/seed-stack.ts
//
// `dev:stack` should hand over a stack that is USABLE, not merely started.
// The bucket is part of that: four vm suites upload to it and assume it is
// there, and only backup-store's own suite creates it. Measured — moving
// RustFS onto its own volume left them all failing on
// `bucket "noddle-verify" not found`, which reads as a broken destination
// rather than an empty one.
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { devStack } from "#dev-stack";

const { s3 } = devStack();

const client = new S3Client({
  credentials: {
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  },
  endpoint: s3.endpoint,
  // Outside AWS the bucket is a PATH, not a subdomain: `bucket.host` does
  // not resolve against a local RustFS.
  forcePathStyle: true,
  region: "us-east-1",
});

try {
  await client.send(new CreateBucketCommand({ Bucket: s3.bucket }));
  process.stdout.write(`  created bucket ${s3.bucket}\n`);
} catch (error) {
  // "It is already mine" is the normal case on every run after the first.
  // Anything else is NOT: swallowing it announced a bucket that was never
  // created, and four vm suites then failed on a missing destination — the
  // same bare-catch mistake this repo just fixed in prune.ts.
  const name = error instanceof Error ? error.name : "";
  if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
    process.stdout.write(`  bucket ${s3.bucket} ready\n`);
  } else {
    throw new Error(
      `could not create the ${s3.bucket} bucket on ${s3.endpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}
