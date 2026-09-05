// tier: pure
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const SERVER_DIR = join(import.meta.dirname, "server");

const RESTRICTED_GETS = [
  "getAuditLog",
  "getDatabaseCredentials",
  "getEnvVars",
  "getRegistries",
  "getRegistryOptions",
  "getSshKeys",
  "listBackupObjects",
];

const NEXT_DECLARATION = "\nexport const ";

function listServerTs(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listServerTs(join(dir, entry.name), rel));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out;
}

function declarationBody(source: string, name: string): string | null {
  const start = source.indexOf(`export const ${name}`);
  if (start === -1) {
    return null;
  }
  const rest = source.slice(start);
  const next = rest.slice(1).indexOf(NEXT_DECLARATION);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

await runVerify("runRead adoption", () => {
  const files = listServerTs(SERVER_DIR);
  const perm = readFileSync(
    join(import.meta.dirname, "lib/permission.server.ts"),
    "utf-8"
  );

  check(
    "runRead is exported from permission.server",
    perm.includes("export async function runRead")
  );

  for (const name of RESTRICTED_GETS) {
    const found = files.flatMap((file) => {
      const body = declarationBody(
        readFileSync(join(SERVER_DIR, file), "utf-8"),
        name
      );
      return body === null ? [] : [{ body, file }];
    });

    if (found.length !== 1) {
      check(
        `${name} is declared exactly once under server/`,
        false,
        found.length === 0
          ? "not found"
          : `declared in ${found.map((f) => f.file).join(", ")}`
      );
      continue;
    }

    const [only] = found;
    if (!only) {
      continue;
    }
    check(`${name} uses runRead`, only.body.includes("runRead("), only.file);
    check(
      `${name} does not call requirePermission directly`,
      !only.body.includes("requirePermission("),
      only.file
    );
  }
});
