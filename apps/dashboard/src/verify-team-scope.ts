// tier: pure
import { readFileSync } from "node:fs";

import { check, runVerify, suite } from "@noddle/testing";

const SOURCE = new URL("lib/guarded.server.ts", import.meta.url).pathname;
const source = readFileSync(SOURCE, "utf-8");

function listOf(name: string): string[] {
  const block = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(
    source
  );
  return [...(block?.[1] ?? "").matchAll(/"([a-zA-Z]+)"/g)].map(
    (match) => match[1] as string
  );
}

function loaderKeys(): string[] {
  const registry = source.slice(source.indexOf("export const guarded = {"));
  return [...registry.matchAll(/^ {2}([a-zA-Z]+): \(/gm)].map(
    (match) => match[1] as string
  );
}

function bodyOf(loader: string): string {
  const registry = source.slice(source.indexOf("export const guarded = {"));
  const start = registry.indexOf(`  ${loader}: (`);
  const next = registry.slice(start + 1).search(/^ {2}[a-zA-Z]+: \(/m);
  return next === -1
    ? registry.slice(start)
    : registry.slice(start, start + 1 + next);
}

const scoped = listOf("TEAM_SCOPED_LOADERS");
const installation = listOf("INSTALLATION_LOADERS");
const keys = loaderKeys();

await runVerify("team scope", async () => {
  await suite("every loader is classified, none by default", () => {
    check("the registry was found at all", keys.length > 0, `${keys.length}`);
    check(
      "the two lists cover it exactly",
      keys.length === scoped.length + installation.length,
      `${keys.length} loaders against ${scoped.length}+${installation.length}`
    );

    for (const key of keys) {
      const inScoped = scoped.includes(key);
      const inInstallation = installation.includes(key);
      check(
        `${key} is declared exactly once`,
        (inScoped ? 1 : 0) + (inInstallation ? 1 : 0) === 1,
        inScoped || inInstallation ? "declared twice" : "not classified"
      );
    }
  });

  await suite("a team-owned row is never read without the team", () => {
    for (const loader of scoped) {
      const body = bodyOf(loader);
      check(
        `${loader} filters by the active team`,
        body.includes("activeTeamId()"),
        "a by-id read with no team filter returns another team's row"
      );
      check(
        `${loader} takes the team from the session, not an argument`,
        !/teamId[?]?:\s*string/.test(body),
        "a caller-supplied team is a caller-chosen team"
      );
    }
  });

  await suite(
    "the installation's own things stay unscoped, deliberately",
    () => {
      for (const loader of installation) {
        check(
          `${loader} is not team-filtered`,
          !bodyOf(loader).includes("activeTeamId()"),
          "servers, keys and registries belong to the installation"
        );
      }
    }
  );
});
