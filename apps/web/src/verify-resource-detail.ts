// bun run apps/web/src/verify-resource-detail.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, runVerify } from "@noddle/testing";

const WEB_SRC = join(import.meta.dirname);
const ROUTES = join(WEB_SRC, "routes");
const LIB = join(WEB_SRC, "lib/resource-detail");

const DETAIL_ROUTES = [
  "projects_.$projectId_.$environmentId_.services.$serviceId.tsx",
  "projects_.$projectId_.$environmentId_.databases.$databaseId.tsx",
  "projects_.$projectId_.$environmentId_.stacks.$stackId.tsx",
] as const;

await runVerify("resource detail module (C6)", () => {
  const workload = readFileSync(join(LIB, "constants.ts"), "utf8");
  check(
    "shared constants export tab panel class",
    workload.includes("DETAIL_TAB_PANEL_CLASS")
  );

  for (const file of DETAIL_ROUTES) {
    const src = readFileSync(join(ROUTES, file), "utf8");
    check(
      `${file} uses resourceDetailBeforeLoad`,
      src.includes("resourceDetailBeforeLoad")
    );
    check(`${file} uses useLeaveOnDelete`, src.includes("useLeaveOnDelete"));
    check(
      `${file} uses useDetailTabChange`,
      src.includes("useDetailTabChange")
    );
    check(
      `${file} avoids inline signed-in beforeLoad`,
      !src.includes("getAuthState")
    );
  }

  const service = readFileSync(join(ROUTES, DETAIL_ROUTES[0]), "utf8");
  const database = readFileSync(join(ROUTES, DETAIL_ROUTES[1]), "utf8");
  check(
    "service/database share lifecycle poll helper",
    service.includes("lifecyclePollInterval") &&
      database.includes("lifecyclePollInterval")
  );
  check(
    "database uses ResourceDetailFrame",
    database.includes("ResourceDetailFrame")
  );
  check(
    "stack uses ResourceDetailFrame",
    readFileSync(join(ROUTES, DETAIL_ROUTES[2]), "utf8").includes(
      "ResourceDetailFrame"
    )
  );
});
