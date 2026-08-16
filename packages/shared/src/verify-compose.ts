// tier: pure
// bun run packages/shared/src/verify-compose.ts
//
// Two files describe the same services — `installer/docker-compose.yml` for an
// installed Noddle, `compose.dev.yml` for a development machine. Production is
// the reference; development follows it.
//
// They can drift silently, and the symptom would arrive detached from its
// cause: a verify passing locally and failing on an installation, with nothing
// in the diff to connect the two. Same shape as `verify-toolchain`, same
// reason.
//
// RustFS is deliberately NOT checked: production ships no S3 at all — the
// destination is the user's — so there is no counterpart to compare against.
import { readFileSync } from "node:fs";

import { check, runVerify } from "@noddle/testing";

const at = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url).pathname, "utf-8");

const PROD = at("installer/docker-compose.yml");
const DEV = at("compose.dev.yml");
const WEB_ENV = at("apps/web/.env.example");
const WORKER_ENV = at("apps/worker/.env.example");

/** Services both files must agree on. Anything else is one side's own business. */
const SHARED_SERVICES = ["postgres", "redis"];

const APP_KEY_BYTES = 32;

/** A key at exactly two spaces of indentation opens a new service block. */
const NEXT_SERVICE = /^ {2}\S/;
const IMAGE_LINE = /^\s*image:\s*(\S+)/;
const POSTGRES_USER = /POSTGRES_USER:\s*(\S+)/;

/**
 * The `image:` of one service. A service is a key at exactly two spaces of
 * indentation; its block runs until the next one. Text, not a YAML parser —
 * the same choice `verify-toolchain` makes, and for the same reason: the file
 * being read is a fixture, not input.
 */
function imageOf(compose: string, service: string): string | undefined {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  if (start === -1) {
    return;
  }
  for (const line of lines.slice(start + 1)) {
    // a new service block begins: this one had no image
    if (NEXT_SERVICE.test(line)) {
      return;
    }
    const match = line.match(IMAGE_LINE);
    if (match) {
      return match[1];
    }
  }
}

/** The value of one key in a dotenv file, ignoring commented-out lines. */
function envValue(file: string, key: string): string | undefined {
  const match = file.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1];
}

await runVerify("compose parity", () => {
  for (const service of SHARED_SERVICES) {
    const prod = imageOf(PROD, service);
    const dev = imageOf(DEV, service);

    check(
      `${service} is declared on both sides`,
      Boolean(prod && dev),
      `production=${prod ?? "absent"} development=${dev ?? "absent"}`
    );

    check(
      `${service} runs the same image in development as in production`,
      prod === dev,
      `production=${prod} development=${dev}`
    );
  }

  // A development-only service must not creep into the installed stack: it
  // would ship a component nobody asked for and no ADR covers.
  check(
    "rustfs stays out of the production stack",
    imageOf(PROD, "rustfs") === undefined,
    "installer/docker-compose.yml now declares rustfs"
  );

  // The two apps encrypt and decrypt each other's secrets. Different keys do
  // not fail at startup — they fail the first time a secret is read back,
  // which is a long way from the cause.
  for (const key of ["APP_KEY", "DATABASE_URL"]) {
    const web = envValue(WEB_ENV, key);
    const worker = envValue(WORKER_ENV, key);

    check(
      `${key} is present in both .env.example`,
      Boolean(web && worker),
      `web=${web ?? "absent"} worker=${worker ?? "absent"}`
    );

    check(
      `${key} is identical in both .env.example`,
      web === worker,
      `web=${web} worker=${worker}`
    );
  }

  // An example that cannot be copied as-is is not an example: `loadAppKey`
  // rejects anything that is not exactly 32 bytes once base64-decoded, and a
  // contributor would meet that on their first command.
  const appKey = envValue(WEB_ENV, "APP_KEY") ?? "";
  check(
    "the example APP_KEY decodes to the length loadAppKey requires",
    Buffer.from(appKey, "base64").length === APP_KEY_BYTES,
    `got ${Buffer.from(appKey, "base64").length} bytes`
  );

  // The dev DSN carries production's role. The postgres image only creates the
  // role named by POSTGRES_USER, so a `postgres` superuser does not exist on an
  // installed Noddle — a DSN copied across would fail with a message that does
  // not say why.
  const devUser = imageOf(DEV, "postgres") && DEV.match(POSTGRES_USER)?.[1];
  const prodUser = PROD.match(POSTGRES_USER)?.[1];
  check(
    "development and production create the same Postgres role",
    devUser === prodUser,
    `development=${devUser} production=${prodUser}`
  );
});
