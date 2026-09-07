// tier: pure
import { check, runVerify, suite } from "@noddle/testing";

import { can, ROLE_ORDER, statement } from "@/lib/permissions";
import {
  ALL_SCOPES,
  DESTRUCTIVE_SCOPES,
  grantableBy,
  isKnownScope,
  narrowToRole,
  tokenAllows,
} from "@/lib/scopes";

const fromStatement = Object.entries(statement)
  .flatMap(([resource, actions]) =>
    (actions as readonly string[]).map((action) => `${resource}:${action}`)
  )
  .toSorted();

await runVerify("api token scopes", async () => {
  await suite("the vocabulary IS the permission statement", () => {
    check(
      "every statement pair is a scope, and nothing else is",
      ALL_SCOPES.join(",") === fromStatement.join(","),
      `${ALL_SCOPES.length} scopes against ${fromStatement.length} pairs`
    );
    check("a made-up scope is not known", !isKnownScope("service:launch"));
    check("a malformed scope is not known", !isKnownScope("service"));
  });

  await suite("a token can never exceed its owner's live role", () => {
    for (const role of ROLE_ORDER) {
      const everything = narrowToRole(ALL_SCOPES, role);
      const illegal = everything.filter((scope) => {
        const [resource, action] = scope.split(":");
        return !can(role, resource as never, action as string);
      });
      check(
        `${role}: holding every scope narrows to what it may grant`,
        illegal.length === 0,
        illegal.join(", ")
      );
    }

    check(
      "an unauthenticated caller gets nothing",
      narrowToRole(ALL_SCOPES, null).length === 0
    );
    check(
      "an unknown role gets nothing",
      narrowToRole(ALL_SCOPES, "sysadmin").length === 0
    );
  });

  await suite("demotion narrows an existing token, with no rewrite", () => {
    const granted = grantableBy("deployer");
    check(
      "the token was minted able to deploy",
      granted.includes("service:deploy")
    );
    check(
      "as deployer it still deploys",
      tokenAllows(granted, "deployer", "service", "deploy")
    );
    check(
      "demoted to viewer the same token cannot",
      !tokenAllows(granted, "viewer", "service", "deploy")
    );
    check(
      "and keeps only what viewer may grant",
      narrowToRole(granted, "viewer").join(",") ===
        grantableBy("deployer")
          .filter((s) => grantableBy("viewer").includes(s))
          .join(",")
    );
  });

  await suite(
    "destructive scopes are named, not inferred at the call site",
    () => {
      for (const scope of ALL_SCOPES.filter((s) => s.endsWith(":delete"))) {
        check(`${scope} is marked destructive`, DESTRUCTIVE_SCOPES.has(scope));
      }
      check(
        "backup:restore is marked",
        DESTRUCTIVE_SCOPES.has("backup:restore")
      );
      check("server:shell is marked", DESTRUCTIVE_SCOPES.has("server:shell"));
      check(
        "container:shell is marked",
        DESTRUCTIVE_SCOPES.has("container:shell")
      );
      check(
        "a read is never marked",
        ![...DESTRUCTIVE_SCOPES].some((s) => s.endsWith(":read"))
      );
    }
  );

  await suite("capabilities no role grants stay unreachable", () => {
    const anyRole = new Set(ROLE_ORDER.flatMap((role) => grantableBy(role)));
    const unreachable = ALL_SCOPES.filter((scope) => !anyRole.has(scope));
    check(
      "user:impersonate-admins is grantable by nobody",
      unreachable.includes("user:impersonate-admins")
    );
    check(
      "and no token can hold it, whatever its owner",
      ROLE_ORDER.every(
        (role) => !narrowToRole(["user:impersonate-admins"], role).length
      )
    );
  });
});
