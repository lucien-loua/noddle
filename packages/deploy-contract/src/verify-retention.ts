// tier: pure
import { check, runVerify } from "@noddle/testing";

import {
  deployJobSchema,
  JOB_RETENTION,
  JOB_RETRY,
  RETRYABLE_KINDS,
  SCHEDULE_RETENTION,
} from "#index";

const DESTRUCTIVE = [
  "change-database-password",
  "delete-database",
  "delete-server",
  "delete-service",
  "delete-stack",
  "prune-docker",
  "prune-registry",
  "rebuild-database",
  "restore",
];

await runVerify("queue retention and retries", () => {
  check(
    "completed jobs are bounded by both age and count",
    JOB_RETENTION.removeOnComplete.age > 0 &&
      JOB_RETENTION.removeOnComplete.count > 0
  );
  check(
    "failed jobs are kept longer than completed ones, for diagnosis",
    JOB_RETENTION.removeOnFail.age > JOB_RETENTION.removeOnComplete.age
  );
  check(
    "a schedule keeps less than a deploy — it fires every 30s and says little",
    SCHEDULE_RETENTION.removeOnComplete.count <
      JOB_RETENTION.removeOnComplete.count
  );

  check("a retry is attempted more than once", JOB_RETRY.attempts > 1);
  check(
    "and backs off rather than hammering a machine that is already unwell",
    JOB_RETRY.backoff.type === "exponential" && JOB_RETRY.backoff.delay > 0
  );

  for (const kind of DESTRUCTIVE) {
    check(
      `${kind} is NEVER retried — replaying it acts twice`,
      !RETRYABLE_KINDS.has(kind as never)
    );
  }

  const kinds = new Set(
    deployJobSchema.options.map((option) => option.shape.kind.value as string)
  );
  for (const kind of RETRYABLE_KINDS) {
    check(`${kind} is a real job kind`, kinds.has(kind));
  }
  check("something is retryable at all", RETRYABLE_KINDS.size > 0);
});
