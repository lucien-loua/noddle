// tier: pure
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const DASHBOARD_SRC = import.meta.dirname;

await runVerify("engine knowledge stays on ENGINE_SPECS", () => {
  const connectionUrl = readFileSync(
    join(DASHBOARD_SRC, "server/databases/connection-url.ts"),
    "utf-8"
  );

  check(
    "connection-url delegates to connectionUrlFor",
    connectionUrl.includes("connectionUrlFor")
  );
  check(
    "connection-url has no engine switch of its own",
    !connectionUrl.includes("switch (engine)")
  );
});
