/**
 * One `mutationOptions()` per write that owns a cache domain: the
 * mutationFn and the invalidate that follows it, co-located the same way
 * `queries` co-locates key + fetcher.
 *
 * Call-site concerns (toasts, dialog close, reveal-once) stay on the
 * panel — compose them *around* `mutateAsync`, don't override `onSuccess`
 * or the invalidate is lost.
 */
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { DraftVar } from "@/components/features/env-vars/table";
import { cache } from "@/lib/cache";
import { deleteBackup, triggerBackup } from "@/server/backups";
import type { EnvVarTarget } from "@/server/env-vars";
import { saveEnvVars } from "@/server/env-vars";
import { addServer } from "@/server/servers";
import { createSshKey } from "@/server/ssh-keys";

export type CreateSshKeyInput =
  | { mode: "generate"; name: string; type: "ed25519" | "rsa" }
  | { mode: "import"; name: string; privateKey: string };

export interface AddServerInput {
  host: string;
  name: string;
  sshKeyId: string;
  sshPort: number;
  sshUser: string;
}

export const mutations = {
  addServer: (qc: QueryClient) =>
    mutationOptions({
      mutationFn: (data: AddServerInput) => addServer({ data }),
      onSuccess: () => cache.servers(qc),
    }),

  createSshKey: (qc: QueryClient) =>
    mutationOptions({
      mutationFn: (data: CreateSshKeyInput) => createSshKey({ data }),
      onSuccess: () => cache.sshKeys(qc),
    }),

  deleteBackup: (qc: QueryClient, databaseId: string, configId: string) =>
    mutationOptions({
      mutationFn: (backupId: string) => deleteBackup({ data: { backupId } }),
      onSuccess: () => cache.backups(qc, databaseId, configId),
    }),

  saveEnvVars: (qc: QueryClient, target: EnvVarTarget) =>
    mutationOptions({
      mutationFn: (draft: DraftVar[]) =>
        saveEnvVars({
          data: {
            ...target,
            vars: draft.map((v) => ({
              isSecret: v.isSecret,
              key: v.key,
              value: v.value,
            })),
          },
        }),
      onSuccess: () => cache.envVars(qc, target),
    }),

  triggerBackup: (qc: QueryClient, databaseId: string, configId: string) =>
    mutationOptions({
      mutationFn: () => triggerBackup({ data: { configId } }),
      onSuccess: () => cache.backups(qc, databaseId, configId),
    }),
} as const;
