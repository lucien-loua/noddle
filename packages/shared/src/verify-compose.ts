// tier: pure
import { readFileSync } from "node:fs";

import { check, runVerify } from "@noddle/testing";
import { parse } from "yaml";

const at = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url).pathname, "utf-8");

interface ComposeFile {
  services?: Record<
    string,
    { environment?: Record<string, string>; image?: string } | undefined
  >;
}

const PROD = parse(at("installer/docker-compose.yml")) as ComposeFile;
const DEV = parse(at("compose.dev.yml")) as ComposeFile;
const WEB_ENV = at("apps/dashboard/.env.example");
const WORKER_ENV = at("apps/worker/.env.example");

const SHARED_SERVICES = ["postgres", "redis"];

const APP_KEY_BYTES = 32;

function imageOf(compose: ComposeFile, service: string): string | undefined {
  return compose.services?.[service]?.image;
}

function postgresUser(compose: ComposeFile): string | undefined {
  return compose.services?.postgres?.environment?.POSTGRES_USER;
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

  const devUser = postgresUser(DEV);
  const prodUser = postgresUser(PROD);
  check(
    "development and production create the same Postgres role",
    devUser === prodUser,
    `development=${devUser} production=${prodUser}`
  );
});
