// tier: pure
import { readFileSync } from "node:fs";

import { check, runVerify } from "@noddle/testing";

const at = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url).pathname, "utf-8");

const PROD = at("installer/docker-compose.yml");
const DEV = at("compose.dev.yml");
const WEB_ENV = at("apps/web/.env.example");
const WORKER_ENV = at("apps/worker/.env.example");

const SHARED_SERVICES = ["postgres", "redis"];

const APP_KEY_BYTES = 32;

const NEXT_SERVICE = /^ {2}\S/;
const IMAGE_LINE = /^\s*image:\s*(\S+)/;
const POSTGRES_USER = /POSTGRES_USER:\s*(\S+)/;

function imageOf(compose: string, service: string): string | undefined {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  if (start === -1) {
    return;
  }
  for (const line of lines.slice(start + 1)) {
    if (NEXT_SERVICE.test(line)) {
      return;
    }
    const match = line.match(IMAGE_LINE);
    if (match) {
      return match[1];
    }
  }
}

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

  check(
    "rustfs stays out of the production stack",
    imageOf(PROD, "rustfs") === undefined,
    "installer/docker-compose.yml now declares rustfs"
  );

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

  const appKey = envValue(WEB_ENV, "APP_KEY") ?? "";
  check(
    "the example APP_KEY decodes to the length loadAppKey requires",
    Buffer.from(appKey, "base64").length === APP_KEY_BYTES,
    `got ${Buffer.from(appKey, "base64").length} bytes`
  );

  const devUser = imageOf(DEV, "postgres") && DEV.match(POSTGRES_USER)?.[1];
  const prodUser = PROD.match(POSTGRES_USER)?.[1];
  check(
    "development and production create the same Postgres role",
    devUser === prodUser,
    `development=${devUser} production=${prodUser}`
  );
});
