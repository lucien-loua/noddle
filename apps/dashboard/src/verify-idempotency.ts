// tier: local
import { randomBytes } from "node:crypto";

import { check, runVerify, suite } from "@noddle/testing";
import { devStack } from "@noddle/testing/dev-stack";
import IORedis from "ioredis";

import {
  idempotencyKey,
  IDEMPOTENCY_TTL_SECONDS,
  idempotencyStore,
  MAX_IDEMPOTENCY_KEY,
  readIdempotencyHeader,
} from "@/lib/idempotency.server";

const redis = new IORedis(devStack().redisUrl, { maxRetriesPerRequest: null });
const store = idempotencyStore(redis);

const tokenA = `tok_${randomBytes(6).toString("hex")}`;
const tokenB = `tok_${randomBytes(6).toString("hex")}`;
const key = `key_${randomBytes(6).toString("hex")}`;
const body = { deploymentId: "d-1", status: "queued" };

const withHeader = (value: string | null) =>
  new Request("http://x/api/v1/services/s/deploy", {
    headers: value === null ? {} : { "idempotency-key": value },
    method: "POST",
  });

await runVerify("api v1 idempotency", async () => {
  await suite("a repeated key replays instead of acting twice", async () => {
    check(
      "nothing is stored before the first call",
      (await store.replay(tokenA, key)) === null
    );

    await store.remember(tokenA, key, { body, status: 200 });
    const again = await store.replay(tokenA, key);

    check("the second call finds the first response", again !== null);
    check(
      "and it is the same body, not a new one",
      JSON.stringify(again?.body) === JSON.stringify(body)
    );
    check("with the same status", again?.status === 200);
  });

  await suite("one token can never replay another's response", async () => {
    check(
      "the same key under a different token is a miss",
      (await store.replay(tokenB, key)) === null
    );
    check(
      "because the token id is part of the key",
      idempotencyKey(tokenA, key) !== idempotencyKey(tokenB, key)
    );
  });

  await suite("a different key is a different action", async () => {
    check(
      "an unseen key does not replay",
      (await store.replay(tokenA, `${key}-other`)) === null
    );
  });

  await suite("the entry expires rather than living forever", async () => {
    const ttl = await redis.ttl(idempotencyKey(tokenA, key));
    check(
      "a TTL is set",
      ttl > 0 && ttl <= IDEMPOTENCY_TTL_SECONDS,
      `ttl=${ttl}`
    );
  });

  await suite("the header is read defensively", () => {
    check(
      "a plain key is taken",
      readIdempotencyHeader(withHeader("abc")) === "abc"
    );
    check(
      "surrounding space is trimmed",
      readIdempotencyHeader(withHeader("  abc  ")) === "abc"
    );
    check(
      "an absent header is null",
      readIdempotencyHeader(withHeader(null)) === null
    );
    check(
      "an empty header is null",
      readIdempotencyHeader(withHeader("   ")) === null
    );
    check(
      "an oversized key is refused rather than stored",
      readIdempotencyHeader(withHeader("x".repeat(MAX_IDEMPOTENCY_KEY + 1))) ===
        null
    );
  });
});

await redis.del(idempotencyKey(tokenA, key));
await redis.quit();
