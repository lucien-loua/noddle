// tier: pure
// bun run apps/web/src/verify-settings-seams.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const WEB_SRC = join(import.meta.dirname);
const FEATURES = join(WEB_SRC, "components/features");
const LIB = join(WEB_SRC, "lib");
const SERVER = join(WEB_SRC, "server");

await runVerify("settings seams (SSH factory + SettingsList)", () => {
  const ssh = readFileSync(join(LIB, "ssh.server.ts"), "utf-8");
  check(
    "ssh.server exports session factories",
    ssh.includes("export async function withServerSession") &&
      ssh.includes("export async function withManagerSession") &&
      ssh.includes("export async function withServerSessionById")
  );

  const containers = readFileSync(join(SERVER, "containers.ts"), "utf-8");
  const updates = readFileSync(join(SERVER, "updates.ts"), "utf-8");
  const volumes = readFileSync(
    join(SERVER, "backups/volume/volumes.server.ts"),
    "utf-8"
  );
  check(
    "containers use withServerSession helpers",
    containers.includes("withServerSession") &&
      containers.includes("withServerSessionById") &&
      !containers.includes("connectToServerById")
  );
  check(
    "updates use withManagerSession",
    updates.includes("withManagerSession") &&
      !updates.includes("connectToManager()")
  );
  check(
    "volume mounts use withManagerSession",
    volumes.includes("withManagerSession")
  );

  const servers = readFileSync(
    join(FEATURES, "servers/servers-panel.tsx"),
    "utf-8"
  );
  const accounts = readFileSync(
    join(FEATURES, "accounts/accounts-panel.tsx"),
    "utf-8"
  );
  const webhooks = readFileSync(join(FEATURES, "webhooks/panel.tsx"), "utf-8");
  check(
    "servers panel uses SettingsList empty/body",
    servers.includes("SettingsList") &&
      servers.includes("useResourceList") &&
      servers.includes("SettingsList.Body")
  );
  check(
    "accounts panel uses SettingsList.Frame",
    accounts.includes("SettingsList.Frame") &&
      !accounts.includes("<Frame variant")
  );
  check(
    "webhook panel uses SettingsList.Frame",
    webhooks.includes("SettingsList.Frame") &&
      !webhooks.includes("<Frame variant")
  );
});
