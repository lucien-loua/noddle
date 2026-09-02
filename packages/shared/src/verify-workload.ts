// tier: pure
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

import {
  MONITOR_SECONDS,
  renderComposeUpdateConfig,
  renderDockerodeUpdateConfig,
  SECOND_NS,
} from "#deploy-policy";
import {
  composeWorkloadDeploy,
  dockerodeWorkloadPolicy,
  resolveDockerodeUpdateConfig,
} from "#workload";

const ROOT = join(import.meta.dirname, "../..");
const REPO = join(ROOT, "..");

await runVerify("workload policy (C2)", () => {
  const dockerode = dockerodeWorkloadPolicy();
  const compose = composeWorkloadDeploy();
  const rendered = renderDockerodeUpdateConfig();

  check(
    "dockerode defaults include UpdateConfig monitor",
    dockerode.UpdateConfig.Monitor === MONITOR_SECONDS * SECOND_NS
  );
  check(
    "dockerode defaults include rollback failure_action pause",
    dockerode.RollbackConfig.FailureAction === "pause"
  );
  check(
    "dockerode defaults match bare renderers",
    JSON.stringify(dockerode.UpdateConfig) === JSON.stringify(rendered)
  );
  check(
    "compose update_config matches renderComposeUpdateConfig",
    JSON.stringify(compose.update_config) ===
      JSON.stringify(renderComposeUpdateConfig())
  );

  const overridden = resolveDockerodeUpdateConfig({ Parallelism: 2 });
  check(
    "swarm settings override merges without dropping defaults",
    overridden.Parallelism === 2 &&
      overridden.Monitor === MONITOR_SECONDS * SECOND_NS
  );

  const swarmOps = readFileSync(
    join(REPO, "packages/swarm-ops/src/swarm.ts"),
    "utf-8"
  );
  const composeEngine = readFileSync(
    join(REPO, "packages/deploy-engine/src/internal/compose.ts"),
    "utf-8"
  );
  const database = readFileSync(
    join(REPO, "apps/worker/src/database/database.ts"),
    "utf-8"
  );

  check(
    "swarm-ops uses dockerodeWorkloadPolicy",
    swarmOps.includes("dockerodeWorkloadPolicy")
  );
  check(
    "compose-engine uses composeWorkloadDeploy",
    composeEngine.includes("composeWorkloadDeploy")
  );
  check(
    "database.ts uses dockerodeWorkloadPolicy",
    database.includes("dockerodeWorkloadPolicy")
  );
  check(
    "database.ts always sets UpdateConfig",
    database.includes("UpdateConfig: workloadPolicy.UpdateConfig")
  );
  check(
    "database.ts no longer omits UpdateConfig conditionally",
    !database.includes("...(updateConfig ? { UpdateConfig")
  );
});
