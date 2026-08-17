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
} catch {
  // Already there: the normal case on every run after the first.
  process.stdout.write(`  bucket ${s3.bucket} ready\n`);
}
