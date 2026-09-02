// tier: pure
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify, suite } from "@noddle/testing";

const WEB_SRC = import.meta.dirname;
const LEGACY_OWNER = "components/use-delete-resource-action.tsx";
const RESOURCE_ACTIONS_OWNER = "lib/resource-actions/dispatch.ts";

const LEGACY_CALLERS = [
  "routes/projects_.$projectId_.$environmentId_.stacks.$stackId.tsx",
] as const;

const MIGRATED_CALLERS = [
  "components/features/environment/resource-grid.tsx",
  "components/features/environment/use-topology-lifecycle.ts",
  "components/features/services/service-danger-zone.tsx",
  "components/features/database/database-header-actions.tsx",
] as const;

const SERVER_FNS = ["deleteService(", "deleteStack(", "deleteDatabase("];

function read(file: string): string {
  return readFileSync(join(WEB_SRC, file), "utf-8");
}

await runVerify("delete action", async () => {
  await suite("exactly two dispatchers own the server functions", () => {
    for (const owner of [LEGACY_OWNER, RESOURCE_ACTIONS_OWNER]) {
      const src = read(owner);
      for (const fn of SERVER_FNS) {
        check(`${owner} calls ${fn})`, src.includes(fn));
      }
    }

    for (const caller of LEGACY_CALLERS) {
      const src = read(caller);
      const named = SERVER_FNS.filter((fn) => src.includes(fn));
      check(
        `${caller.split("/").at(-1)} routes through the legacy dispatcher, not the server fns directly`,
        named.length === 0,
        named.join(", ")
      );
    }

    for (const caller of MIGRATED_CALLERS) {
      const src = read(caller);
      const named = SERVER_FNS.filter((fn) => src.includes(fn));
      check(
        `${caller.split("/").at(-1)} routes through resource-actions, calling neither the server fns nor removeResource directly`,
        named.length === 0 && !src.includes("removeResource("),
        named.join(", ")
      );
      check(
        `${caller.split("/").at(-1)} does reach resource-actions' run()`,
        src.includes(".run(")
      );
    }
  });

  await suite("the three old modules are gone, not merely unused", () => {
    for (const stale of [
      "components/use-delete-service-action.tsx",
      "components/delete-database-action.tsx",
      "components/delete-stack-action.tsx",
    ]) {
      let exists = true;
      try {
        read(stale);
      } catch {
        exists = false;
      }
      check(`${stale.split("/").at(-1)} removed`, !exists);
    }
  });

  await suite("the confirmation is checked against the identity", () => {
    const owner = read(LEGACY_OWNER);
    check(
      "the legacy hook takes `name`, not `label`",
      owner.includes("name: string;") && !owner.includes("label: string;")
    );
    check(
      "bulk delete passes item.name",
      read("components/features/environment/resource-grid.tsx").includes(
        'actions.run(item, "delete", { confirmName: item.name })'
      )
    );
  });
});
