//   bun run apps/web/src/verify-permissions.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  can,
  isPermissionUniversal,
  type PermissionResource,
} from "@/lib/permissions";

const SERVER_DIR = join(import.meta.dirname, "server");

const CREATE_SERVER_FN_RE =
  /export const (\w+) = createServerFn\(\{ method: "(\w+)" \}\)/g;
const REQUIRE_PERM_ACTION_FIRST =
  /requirePermission\(\{[\s\S]*?action:\s*(?:"([^"]+)"|[^,]+)\s*,[\s\S]*?resource:\s*"([^"]+)"[\s\S]*?\}\)/;
const REQUIRE_PERM_RESOURCE_FIRST =
  /requirePermission\(\{[\s\S]*?resource:\s*"([^"]+)"\s*,[\s\S]*?action:\s*(?:"([^"]+)"|[^}]+)\s*[\s\S]*?\}\)/;
const EXPECT_FALSE_LABEL = /CANNOT|cannot|denies|NOTHING|^a viewer cannot/;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

/**
 * Markers that imply a non-universal read. If a GET touches one of these
 * without `requirePermission`, a viewer/deployer could see it — the
 * getEnvVars class of hole. Derived from resources where some role lacks
 * `read` (or the closest action), not a hand-maintained function allowlist.
 */
const RESTRICTED_SOURCE_MARKERS: Array<{
  action: string;
  marker: RegExp;
  resource: PermissionResource;
}> = [
  { action: "read", marker: /\bauditLog\b/, resource: "audit" },
  { action: "read", marker: /\benvVars\b/, resource: "envVar" },
  // findMany = listing the library toward the client. findFirst is the
  // connection path (getContainers) and is covered by server:read.
  {
    action: "read",
    marker: /\bsshKeys\.findMany\b|query\.sshKeys\.findMany\b/,
    resource: "sshKey",
  },
  { action: "read", marker: /\bregistries\b/, resource: "registry" },
];

/** The body of an `export const <name> = createServerFn(...)` declaration,
 *  up to the next declaration. Good enough: these files never nest server
 *  functions. */
function declarations(
  source: string
): { body: string; method: string; name: string }[] {
  const out: { body: string; method: string; name: string }[] = [];
  CREATE_SERVER_FN_RE.lastIndex = 0;
  const found = [...source.matchAll(CREATE_SERVER_FN_RE)];

  for (const [index, match] of found.entries()) {
    const start = match.index;
    const end = found[index + 1]?.index ?? source.length;
    out.push({
      body: source.slice(start, end),
      method: match[2] ?? "?",
      name: match[1] ?? "?",
    });
  }
  return out;
}

function parseRequirePermission(
  body: string
): { action: string; resource: string } | null {
  // Multiline + ternary actions (containerAction) must still count as a guard.
  if (!body.includes("requirePermission(")) {
    return null;
  }
  const match = body.match(REQUIRE_PERM_ACTION_FIRST);
  if (match?.[2]) {
    return { action: match[1] ?? "dynamic", resource: match[2] };
  }
  const alt = body.match(REQUIRE_PERM_RESOURCE_FIRST);
  if (alt?.[1]) {
    return { action: alt[2] ?? "dynamic", resource: alt[1] };
  }
  // Present but unparseable — still a guard (e.g. unusual formatting).
  return { action: "dynamic", resource: "unknown" };
}

console.log("\n\x1b[1mPermission guards on server functions\x1b[0m");

const files = readdirSync(SERVER_DIR).filter((f) => f.endsWith(".ts"));
const unguardedPost: string[] = [];
const unguardedGet: string[] = [];
const universalGuards: string[] = [];
const restrictedWithoutGuard: string[] = [];
let mutating = 0;
let reads = 0;

for (const file of files) {
  const source = readFileSync(join(SERVER_DIR, file), "utf8");
  for (const decl of declarations(source)) {
    const perm = parseRequirePermission(decl.body);
    const hasSession =
      decl.body.includes("requireSession(") ||
      decl.body.includes("getSession(");

    if (decl.method === "POST") {
      mutating += 1;
      if (!perm) {
        unguardedPost.push(`${file}:${decl.name}`);
      }
      continue;
    }

    if (decl.method !== "GET") {
      continue;
    }

    reads += 1;

    if (perm) {
      if (
        perm.resource !== "unknown" &&
        perm.action !== "dynamic" &&
        isPermissionUniversal(perm.resource as PermissionResource, perm.action)
      ) {
        universalGuards.push(
          `${file}:${decl.name} (${perm.resource}:${perm.action})`
        );
      }
    } else if (!hasSession) {
      unguardedGet.push(`${file}:${decl.name}`);
    }

    // Session-only GET that touches a restricted resource → hole.
    if (!perm) {
      for (const marker of RESTRICTED_SOURCE_MARKERS) {
        if (
          marker.marker.test(decl.body) &&
          !isPermissionUniversal(marker.resource, marker.action)
        ) {
          restrictedWithoutGuard.push(
            `${file}:${decl.name} (touches ${marker.resource})`
          );
        }
      }
    }
  }
}

if (mutating === 0) {
  ko("no mutating server function found — detection is broken");
} else {
  ok(`${mutating} mutating server functions enumerated`);
}

if (reads === 0) {
  ko("no GET server function found — detection is broken");
} else {
  ok(`${reads} GET server functions enumerated`);
}

if (unguardedPost.length === 0) {
  ok("all POST handlers declare requirePermission");
} else {
  ko(`POST WITHOUT A GUARD: ${unguardedPost.join(", ")}`);
}

if (unguardedGet.length === 0) {
  ok("all GET handlers declare requirePermission or requireSession/getSession");
} else {
  ko(`GET WITHOUT A GUARD: ${unguardedGet.join(", ")}`);
}

if (universalGuards.length === 0) {
  ok(
    "no GET uses requirePermission for a universal permission (no audit spam)"
  );
} else {
  ko(
    `GET should use requireSession only (universal perm): ${universalGuards.join(", ")}`
  );
}

if (restrictedWithoutGuard.length === 0) {
  ok(
    "no session-only GET touches a restricted resource without requirePermission"
  );
} else {
  ko(
    `RESTRICTED GET WITHOUT requirePermission: ${restrictedWithoutGuard.join(", ")}`
  );
}

// ── The sensitive pairs, spelled out via `can` ─────────────────────────────
// An overly permissive role breaks nothing and shows nothing. These
// assertions exist so that weakening it requires MODIFYING a test, not
// just forgetting one.

console.log("\n\x1b[1mRole matrix (via can)\x1b[0m");

const cases: [string, boolean][] = [
  ["a viewer cannot deploy", can("viewer", "service", "deploy")],
  [
    "a viewer cannot read environment variables",
    can("viewer", "envVar", "read"),
  ],
  ["a deployer can deploy", can("deployer", "service", "deploy")],
  ["a deployer CANNOT restore a backup", can("deployer", "backup", "restore")],
  ["a deployer CANNOT read secrets", can("deployer", "envVar", "read")],
  ["a deployer CANNOT delete a server", can("deployer", "server", "delete")],
  ["a deployer CANNOT delete a service", can("deployer", "service", "delete")],
  // The log shows what OTHERS do, refusals included. Handing it to an
  // operational role would be a permission that's TOO WEAK — exactly what
  // no type system rejects and only these pairs catch.
  ["a viewer CANNOT read the audit log", can("viewer", "audit", "read")],
  ["a deployer CANNOT read the audit log", can("deployer", "audit", "read")],
  // Updating restarts the control plane and applies migrations: that's
  // administration of the installation, not day-to-day operations.
  ["a viewer CANNOT update Noddle", can("viewer", "installation", "update")],
  [
    "a deployer CANNOT update Noddle",
    can("deployer", "installation", "update"),
  ],
  ["an admin can update Noddle", can("admin", "installation", "update")],
  // A registry carries a password that can publish images under the
  // installation's identity — the same boundary as `sshKey`.
  ["a viewer CANNOT read registries", can("viewer", "registry", "read")],
  ["a deployer CANNOT read registries", can("deployer", "registry", "read")],
  [
    "an admin can manage registries",
    can("admin", "registry", "read") &&
      can("admin", "registry", "create") &&
      can("admin", "registry", "delete"),
  ],
  // Restarting is operational; deleting a container can't be undone.
  [
    "a deployer can restart a container",
    can("deployer", "container", "operate"),
  ],
  [
    "a deployer CANNOT delete a container",
    can("deployer", "container", "delete"),
  ],
  [
    "a viewer can do NOTHING to a container",
    can("viewer", "container", "operate"),
  ],
  [
    "a deployer can start or stop a database",
    can("deployer", "database", "operate"),
  ],
  [
    "a deployer CANNOT delete a database",
    can("deployer", "database", "delete"),
  ],
  [
    "a viewer CANNOT start or stop a database",
    can("viewer", "database", "operate"),
  ],
  // The prune switch is an infrastructure setting, not an operational
  // action: a `deployer` ships, they don't configure machines.
  [
    "a deployer CANNOT set a server's prune switch",
    can("deployer", "server", "update"),
  ],
  [
    "a viewer CANNOT set a server's prune switch",
    can("viewer", "server", "update"),
  ],
  [
    "an admin can set a server's prune switch",
    can("admin", "server", "update"),
  ],
  ["unknown role denies", can("nope", "service", "read")],
  ["null role denies", can(null, "service", "read")],
];

for (const [label, actual] of cases) {
  // Labels that say CANNOT / denies / NOTHING expect false; others true.
  const expectFalse = EXPECT_FALSE_LABEL.test(label);
  if (actual === !expectFalse) {
    ok(label);
  } else {
    ko(`${label} — got ${actual}`);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
