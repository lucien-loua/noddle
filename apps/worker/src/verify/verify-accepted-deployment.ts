// tier: pure
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify, suite } from "@noddle/testing";

const WORKER_SRC = join(import.meta.dirname, "..");
const NEXT_ASYNC_FUNCTION = /\n(?:export )?async function /;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "verify") {
      continue;
    }
    const path = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkTs(path));
      continue;
    }
    if (ent.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

function functionBody(src: string, name: string): string {
  const exportedAt = src.indexOf(`export async function ${name}`);
  const start =
    exportedAt === -1 ? src.indexOf(`async function ${name}`) : exportedAt;
  if (start === -1) {
    return "";
  }
  const rest = src.slice(start);
  const next = rest.slice(1).search(NEXT_ASYNC_FUNCTION);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

await runVerify(
  "accepted deployment (arming lives in one module)",
  async () => {
    await suite("arming lives in one module", () => {
      const accepted = readFileSync(
        join(WORKER_SRC, "deploy/accepted-deployment.ts"),
        "utf-8"
      );
      const deploy = readFileSync(
        join(WORKER_SRC, "deploy/deploy.ts"),
        "utf-8"
      );
      const compose = readFileSync(
        join(WORKER_SRC, "deploy/compose.ts"),
        "utf-8"
      );

      check(
        "accepted-deployment imports watchUntilFor",
        accepted.includes(
          'import { watchUntilFor } from "@noddle/deploy-engine";'
        )
      );
      check(
        "deploy.ts does not import watchUntilFor",
        !deploy.includes("watchUntilFor")
      );
      check(
        "compose.ts does not import watchUntilFor",
        !compose.includes("watchUntilFor")
      );

      const armingFiles = walkTs(WORKER_SRC).filter((path) =>
        readFileSync(path, "utf-8").includes("watchUntilFor")
      );
      const armingNames = armingFiles.map((path) => path.split("/").at(-1));
      check(
        "only accepted-deployment.ts arms watchUntilFor in the worker",
        armingNames.length === 1 && armingNames[0] === "accepted-deployment.ts"
      );

      check(
        "ship Service records via recordAcceptedService",
        functionBody(deploy, "buildAndDeployService").includes(
          "recordAcceptedService"
        )
      );
      check(
        "Rollback / watch_revert Service records via recordAcceptedService",
        functionBody(deploy, "redeployImage").includes("recordAcceptedService")
      );
      check(
        "ship Stack records via recordAcceptedStack",
        functionBody(compose, "buildAndDeployStack").includes(
          "recordAcceptedStack"
        )
      );
      check(
        "Rollback / watch_revert Stack records via recordAcceptedStack",
        functionBody(compose, "redeployStack").includes("recordAcceptedStack")
      );
    });
  }
);
