// tier: pure
// bun run packages/shared/src/verify-deploy-policy.ts

import { check, runVerify } from "@noddle/testing";

import {
  DeployPolicy,
  httpHealthcheckTest,
  MONITOR_SECONDS,
  renderComposeHttpHealthcheck,
  renderComposeUpdateConfig,
  renderDockerodeHttpHealthcheck,
  renderDockerodeUpdateConfig,
  SECOND_NS,
} from "#deploy-policy";

await runVerify("deploy policy renderers", () => {
  check("ADR-0012 monitor is 45s", MONITOR_SECONDS === 45);
  check(
    "dockerode Monitor is monitorSeconds in nanoseconds",
    renderDockerodeUpdateConfig().Monitor === MONITOR_SECONDS * SECOND_NS
  );
  check(
    "compose monitor string matches the same seconds",
    renderComposeUpdateConfig().monitor === `${MONITOR_SECONDS}s`
  );
  check(
    "update failure_action is rollback on both renderers",
    renderDockerodeUpdateConfig().FailureAction === "rollback" &&
      renderComposeUpdateConfig().failure_action === "rollback"
  );
  check(
    "order is start-first on both renderers",
    renderDockerodeUpdateConfig().Order === "start-first" &&
      renderComposeUpdateConfig().order === "start-first"
  );

  const port = 3000;
  const dockerHc = renderDockerodeHttpHealthcheck(port);
  const composeHc = renderComposeHttpHealthcheck(port);
  check(
    "healthcheck test command is identical across renderers",
    JSON.stringify(dockerHc.Test) === JSON.stringify(composeHc.test) &&
      JSON.stringify(dockerHc.Test) ===
        JSON.stringify(httpHealthcheckTest(port))
  );
  check(
    "healthcheck retries match DeployPolicy",
    dockerHc.Retries === DeployPolicy.healthcheck.retries &&
      composeHc.retries === DeployPolicy.healthcheck.retries
  );
});
