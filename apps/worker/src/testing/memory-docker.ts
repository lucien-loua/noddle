import type { DockerApi } from "@noddle/ssh-executor";

const SERVICE_NAME_FILTER = /name=([^,]+)/;

export interface MemoryDockerService {
  ID: string;
  Spec?: { Name?: string; Mode?: { Replicated?: { Replicas?: number } } };
  UpdateStatus?: { Message?: string; State?: string };
  Version?: { Index?: number };
}

export interface MemoryDockerTask {
  DesiredState?: string;
  Status?: { Err?: string; State?: string };
}

export interface MemoryDockerState {
  services: MemoryDockerService[];
  tasks?: MemoryDockerTask[];
}

export function createMemoryDockerApi(initial?: MemoryDockerState): DockerApi {
  const state: MemoryDockerState = initial ?? { services: [] };
  return {
    createService: (spec: { Name?: string }) => {
      const service: MemoryDockerService = {
        ID: `mem-${state.services.length + 1}`,
        Spec: spec as MemoryDockerService["Spec"],
        Version: { Index: 1 },
      };
      state.services.push(service);
      return Promise.resolve(service);
    },
    getService: (id: string) => ({
      inspect: () => {
        const found = state.services.find((s) => s.ID === id);
        if (!found) {
          throw new Error(`service ${id} not found`);
        }
        return Promise.resolve(found);
      },
      update: (spec: unknown) => {
        const index = state.services.findIndex((s) => s.ID === id);
        if (index === -1) {
          throw new Error(`service ${id} not found`);
        }
        const existing = state.services[index];
        if (!existing) {
          throw new Error(`service ${id} not found`);
        }
        state.services[index] = {
          ID: existing.ID,
          Spec: spec as MemoryDockerService["Spec"],
          Version: existing.Version,
        };
        return Promise.resolve();
      },
    }),
    info: () => Promise.resolve({ MemTotal: 2_147_483_648 }),
    listTasks: () => Promise.resolve(state.tasks ?? []),
    listServices: (opts?: { filters?: string }) => {
      const nameMatch = opts?.filters?.match(SERVICE_NAME_FILTER)?.[1];
      if (!nameMatch) {
        return Promise.resolve(state.services);
      }
      return Promise.resolve(
        state.services.filter((s) => s.Spec?.Name === nameMatch)
      );
    },
    version: () =>
      Promise.resolve({
        ApiVersion: "1.44",
        MinAPIVersion: "1.24",
        Version: "29.0.0",
      }),
  } as unknown as DockerApi;
}
