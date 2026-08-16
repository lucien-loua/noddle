// tier: pure
// bun run apps/web/src/verify-run-read.ts
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

await runVerify("runRead adoption", () => {
  const sources = listServerTs(SERVER_DIR).map((file) =>
    readFileSync(join(SERVER_DIR, file), "utf8")
  );
  const combined = sources.join("\n");
  const perm = readFileSync(
    join(import.meta.dirname, "lib/permission.server.ts"),
    "utf8"
  );

  check(
    "runRead is exported from permission.server",
    perm.includes("export async function runRead")
  );

  for (const name of RESTRICTED_GETS) {
    check(
      `${name} uses runRead`,
      new RegExp(`export const ${name}[\\s\\S]*?runRead\\(`).test(combined)
    );
  }

  const stillDirect = RESTRICTED_GETS.filter((name) =>
    new RegExp(`export const ${name}[\\s\\S]*?requirePermission\\(`).test(
      combined
    )
  );
  check(
    "no restricted GET still calls requirePermission directly",
    stillDirect.length === 0,
    stillDirect.join(", ")
  );
});
