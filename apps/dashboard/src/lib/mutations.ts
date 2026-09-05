import { mutationOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import type { DraftVar } from "@/components/features/env-vars/table";
import {
  databaseBackupSubject,
  volumeBackupSubject,
} from "@/lib/backup-subject";
import type { BackupSubject } from "@/lib/backup-subject";
import { cache } from "@/lib/cache";
import { deleteBackup, triggerBackup } from "@/server/backups/runs";
import {
  deleteVolumeBackup,
  triggerVolumeBackup,
} from "@/server/backups/volume/runs";
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
    mutations.deleteBackupRun(qc, databaseBackupSubject(databaseId), configId),

  deleteBackupRun: (
    qc: QueryClient,
    subject: BackupSubject,
    configId: string
  ) =>
    mutationOptions({
      mutationFn: (backupId: string) =>
        subject.kind === "database"
          ? deleteBackup({ data: { backupId } })
          : deleteVolumeBackup({ data: { backupId } }),
      onSuccess: () => cache.backupRunsFor(qc, subject, configId),
    }),

  deleteVolumeBackup: (qc: QueryClient, serviceId: string, configId: string) =>
    mutations.deleteBackupRun(qc, volumeBackupSubject(serviceId), configId),

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
    mutations.triggerBackupRun(qc, databaseBackupSubject(databaseId), configId),

  triggerBackupRun: (
    qc: QueryClient,
    subject: BackupSubject,
    configId: string
  ) =>
    mutationOptions({
      mutationFn: async () => {
        if (subject.kind === "database") {
          await triggerBackup({ data: { configId } });
          return;
        }
        await triggerVolumeBackup({ data: { configId } });
      },
      onSuccess: () => cache.backupRunsFor(qc, subject, configId),
    }),

  triggerVolumeBackup: (qc: QueryClient, serviceId: string, configId: string) =>
    mutations.triggerBackupRun(qc, volumeBackupSubject(serviceId), configId),
} as const;
