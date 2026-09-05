// tier: pure
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { servers } from "@noddle/db/schema";
import type { SshClient } from "@noddle/ssh-executor";
import { check, runVerify } from "@noddle/testing";

import { withDeployClients } from "#job-run";
import { createDeployContext } from "#runtime-context";
import { createMemoryDockerApi } from "#testing/memory-docker";

const WORKER_SRC = join(import.meta.dirname, "..");
const LEGACY_CONNECT = "connectTo(ctx,";
const LEGACY_DEPLOY_CONNECT = "connectForDeploy(ctx,";
const STATIC_CONNECT_FOR_DEPLOY_IMPORT = /import\s*\{[^}]*\bconnectForDeploy\b/;

const PRODUCTION_FILES = [
  "containers.ts",
  "metrics.ts",
  "prune.ts",
  "deploy/deploy.ts",
  "deploy/registry-sweep.ts",
  "deploy/sweep.ts",
  "target/teardown-server.ts",
  "backup-run/pipeline.ts",
  "backup-run/subjects/volume-restore.ts",
  "jobs/job-run.ts",
] as const;

await runVerify("DockerApi seam (C4)", async () => {
  const jobRun = readFileSync(join(WORKER_SRC, "jobs/job-run.ts"), "utf-8");

  check(
    "withDeployClients does not import connectForDeploy statically",
    !STATIC_CONNECT_FOR_DEPLOY_IMPORT.test(jobRun)
  );

  for (const file of PRODUCTION_FILES) {
    const src = readFileSync(join(WORKER_SRC, file), "utf-8");
    check(`${file} avoids connectTo(ctx`, !src.includes(LEGACY_CONNECT));
    if (file === "jobs/job-run.ts") {
      check(
        `${file} avoids connectForDeploy(ctx`,
        !src.includes(LEGACY_DEPLOY_CONNECT)
      );
    }
  }

  let createDockerApiCalls = 0;
  const mockClient = {
    end: () => {},
  } as unknown as SshClient;
  const server = {
    id: "11111111-1111-4111-8111-111111111111",
  } as typeof servers.$inferSelect;
  const ctx = createDeployContext(
    {
      appKey: Buffer.alloc(32),
      db: {} as never,
    },
    {
      connectForDeploy: async () => ({
        buildClient: mockClient,
        managerClient: mockClient,
        sameConnection: true,
      }),
      createDockerApi: () => {
        createDockerApiCalls += 1;
        return createMemoryDockerApi();
      },
    }
  );

  await withDeployClients(ctx, server, async ({ managerDocker }) => {
    check(
      "in-memory adapter lists services",
      Array.isArray(await managerDocker.listServices())
    );
  });
  check(
    "createDockerApi invoked for deploy clients",
    createDockerApiCalls >= 1
  );
});
