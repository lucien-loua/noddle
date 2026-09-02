import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { devStack } from "#dev-stack";

const { s3 } = devStack();

const client = new S3Client({
  credentials: {
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  },
  endpoint: s3.endpoint,
  forcePathStyle: true,
  region: "us-east-1",
});

try {
  await client.send(new CreateBucketCommand({ Bucket: s3.bucket }));
  process.stdout.write(`  created bucket ${s3.bucket}\n`);
} catch (error) {
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
