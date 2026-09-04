// tier: pure
import { readFileSync } from "node:fs";
import path from "node:path";

import { check, runVerify } from "@noddle/testing";

const WEB_SRC = path.join(import.meta.dirname);
const FEATURES = path.join(WEB_SRC, "components/features");
const LIB = path.join(WEB_SRC, "lib");
const SERVER = path.join(WEB_SRC, "server");

await runVerify("settings seams (SSH factory + SettingsList)", () => {
  const ssh = readFileSync(path.join(LIB, "ssh.server.ts"), "utf-8");
  check(
    "ssh.server exports session factories",
    ssh.includes("export async function withServerSession") &&
      ssh.includes("export async function withManagerSession") &&
      ssh.includes("export async function withServerSessionById")
  );

  const containers = readFileSync(path.join(SERVER, "containers.ts"), "utf-8");
  const updates = readFileSync(path.join(SERVER, "updates.ts"), "utf-8");
  const volumes = readFileSync(
    path.join(SERVER, "backups/volume/volumes.server.ts"),
    "utf-8"
  );
  check(
    "containers use withServerSession helpers",
    containers.includes("withServerSession") &&
      containers.includes("withServerSessionById") &&
      !containers.includes("connectToServerById")
  );
  check(
    "updates target the self host, which is where /opt/noddle lives",
    updates.includes("withSelfSession") &&
      !(updates.includes("withManagerSession") || updates.includes("connectTo"))
  );
  check(
    "volume mounts use withManagerSession",
    volumes.includes("withManagerSession")
  );

  const servers = readFileSync(
    path.join(FEATURES, "servers/servers-panel.tsx"),
    "utf-8"
  );
  const accounts = readFileSync(
    path.join(FEATURES, "accounts/accounts-panel.tsx"),
    "utf-8"
  );
  const webhooks = readFileSync(
    path.join(FEATURES, "webhooks/panel.tsx"),
    "utf-8"
  );
  check(
    "servers panel uses SettingsList empty/frame",
    servers.includes("useResourceList") &&
      servers.includes("SettingsList.Empty") &&
      servers.includes("SettingsList.Frame") &&
      !servers.includes("<Frame variant")
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
