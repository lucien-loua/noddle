// tier: pure
import { awaitSwarmVerdict } from "@noddle/deploy-engine";
import type { DockerApi } from "@noddle/ssh-executor";
import { check, runVerify, suite } from "@noddle/testing";

import { createMemoryDockerApi } from "#testing/memory-docker";
import type { MemoryDockerState } from "#testing/memory-docker";

function spyDocker(state: MemoryDockerState): {
  docker: DockerApi;
  taskReads: () => number;
} {
  const inner = createMemoryDockerApi(state) as unknown as {
    listTasks: (opts?: unknown) => Promise<unknown[]>;
  };
  let reads = 0;
  const docker = {
    ...inner,
    listTasks: (opts?: unknown) => {
      reads += 1;
      return inner.listTasks(opts);
    },
  } as unknown as DockerApi;
  return { docker, taskReads: () => reads };
}

const RUNNING = { services: [{ ID: "1", Spec: { Name: "svc" } }] };

function withUpdateStatus(state: string, message?: string): MemoryDockerState {
  return {
    services: [
      {
        ID: "1",
        Spec: { Name: "svc" },
        UpdateStatus: { Message: message, State: state },
      },
    ],
    tasks: [{ Status: { State: "running" } }],
  };
}

await runVerify("Swarm verdict ordering", async () => {
  await suite("a create converges on the TASKS", async () => {
    const { docker, taskReads } = spyDocker({
      ...RUNNING,
      tasks: [{ Status: { State: "running" } }],
    });

    const verdict = await awaitSwarmVerdict(docker, "svc", { created: true });

    check("the tasks are read on a create", taskReads() >= 1);
    check("created is reported back", verdict.created === true);
    check("a fresh create has no updateState", verdict.updateState === null);
    check("no UpdateStatus counts as accepted", verdict.accepted === true);
  });

  await suite("an update never reads the tasks", async () => {
    const { docker, taskReads } = spyDocker(withUpdateStatus("completed"));

    const verdict = await awaitSwarmVerdict(docker, "svc", { created: false });

    check("the tasks are NOT read on an update", taskReads() === 0);
    check("completed is accepted", verdict.accepted === true);
    check("state is carried through", verdict.updateState === "completed");
    check("created is false", verdict.created === false);
  });

  await suite("a rollback is a FAILED deploy, not a success", async () => {
    for (const state of ["rollback_completed", "rollback_paused", "paused"]) {
      const { docker } = spyDocker(withUpdateStatus(state, `swarm: ${state}`));

      const verdict = await awaitSwarmVerdict(docker, "svc", {
        created: false,
      });
      check(`${state} is refused`, verdict.accepted === false);
      check(
        `${state} carries its message`,
        verdict.updateMessage === `swarm: ${state}`
      );
    }
  });

  await suite("a service that vanished mid-read reports nothing", async () => {
    const { docker } = spyDocker({ services: [] });

    const verdict = await awaitSwarmVerdict(docker, "gone", { created: false });
    check("no service, no state", verdict.updateState === null);
    check("no running image", verdict.runningImage === null);
  });
});
