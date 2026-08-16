// tier: pure
// bun run apps/web/src/verify-resource-detail.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const WEB_SRC = join(import.meta.dirname);
const ROUTES = join(WEB_SRC, "routes");
const LIB = join(WEB_SRC, "lib/resource-detail");
const FEATURES = join(WEB_SRC, "components/features");

const DETAIL_ROUTES = [
  "projects_.$projectId_.$environmentId_.services.$serviceId.tsx",
  "projects_.$projectId_.$environmentId_.databases.$databaseId.tsx",
  "projects_.$projectId_.$environmentId_.stacks.$stackId.tsx",
] as const;

await runVerify("resource detail module (C6)", () => {
  const workload = readFileSync(join(LIB, "constants.ts"), "utf-8");
  check(
    "shared constants export tab panel class",
    workload.includes("DETAIL_TAB_PANEL_CLASS")
  );
  check(
    "ActiveTabPanel helper exists",
    readFileSync(join(LIB, "active-tab.tsx"), "utf-8").includes(
      "export function ActiveTabPanel"
    )
  );

  for (const file of DETAIL_ROUTES) {
    const src = readFileSync(join(ROUTES, file), "utf-8");
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

  const service = readFileSync(join(ROUTES, DETAIL_ROUTES[0]), "utf-8");
  const database = readFileSync(join(ROUTES, DETAIL_ROUTES[1]), "utf-8");
  check(
    "service/database share lifecycle poll helper",
    service.includes("lifecyclePollInterval") &&
      database.includes("lifecyclePollInterval")
  );
  check(
    "service uses ResourceDetailFrame",
    service.includes("ResourceDetailFrame")
  );
  check(
    "database uses ResourceDetailFrame",
    database.includes("ResourceDetailFrame")
  );
  check(
    "stack uses ResourceDetailFrame",
    readFileSync(join(ROUTES, DETAIL_ROUTES[2]), "utf-8").includes(
      "ResourceDetailFrame"
    )
  );
  check(
    "service/database/stack mount heavy tabs via ActiveTabPanel",
    service.includes("ActiveTabPanel") &&
      database.includes("ActiveTabPanel") &&
      readFileSync(join(ROUTES, DETAIL_ROUTES[2]), "utf-8").includes(
        "ActiveTabPanel"
      )
  );
  check(
    "service/stack lazy-load heavy tab panels",
    service.includes("lazy(") &&
      service.includes("ContainerLogs") &&
      readFileSync(join(ROUTES, DETAIL_ROUTES[2]), "utf-8").includes("lazy(")
  );
  check(
    "database header actions live in feature module",
    !database.includes("function DatabaseHeaderActions") &&
      readFileSync(
        join(FEATURES, "database/database-header-actions.tsx"),
        "utf-8"
      ).includes("export function DatabaseHeaderActions")
  );
  check(
    "database actions compose flat toolbar (no dropdown menu)",
    (() => {
      const src = readFileSync(
        join(FEATURES, "database/database-header-actions.tsx"),
        "utf-8"
      );
      return (
        src.includes("DatabaseActionsToolbar") &&
        src.includes("ConfirmActionDialog") &&
        !src.includes("DropdownMenu")
      );
    })()
  );

  const deploySettings = readFileSync(
    join(FEATURES, "services/service-deploy-settings.tsx"),
    "utf-8"
  );
  check(
    "deploy toolbar composes children (no showDeploy props)",
    !(
      deploySettings.includes("showDeploy") ||
      deploySettings.includes("showReload")
    ) && deploySettings.includes("DeploySettingsToolbar")
  );
});
