/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BackupHistoryTable } from "@/components/features/backup-shared/history-table";
import { BackupRunDetailDialog } from "@/components/features/backup-shared/run-detail-dialog";
import { volumeRunLogs } from "@/components/features/backup-shared/run-logs";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { volumeBackupSubject } from "@/lib/backup-subject";
import { mutations } from "@/lib/mutations";
import { queries } from "@/lib/queries";
import type {
  VolumeBackupConfigRow,
  VolumeBackupRow,
} from "@/server/volume-backups";

const POLL_MS = 3000;
const HISTORY_LIMIT = 10;

export function VolumeBackupHistoryDialog({
  canCreate,
  canRestore,
  config,
  onOpenChange,
  onRestore,
  open,
  serviceId,
}: {
  canCreate: boolean;
  canRestore: boolean;
  config: VolumeBackupConfigRow;
  onOpenChange: (open: boolean) => void;
  onRestore: (backup: VolumeBackupRow) => void;
  open: boolean;
  serviceId: string;
}) {
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<VolumeBackupRow | null>(null);
  const subject = volumeBackupSubject(serviceId);
  const backups = useQuery({
    ...queries.volumeBackups(serviceId, config.id),
    refetchInterval: (query) =>
      query.state.data?.some(
        (b: VolumeBackupRow) => b.status === "queued" || b.status === "running"
      )
        ? POLL_MS
        : false,
  });

  const remove = useMutation(
    mutations.deleteBackupRun(queryClient, subject, config.id)
  );

  const rows = backups.isLoading
    ? undefined
    : (backups.data ?? []).slice(0, HISTORY_LIMIT);

  return (
    <FocusModal onOpenChange={onOpenChange} open={open}>
      <FocusModalContent>
        <FocusModalHeader>
          <FocusModalTitle>Volume backup history</FocusModalTitle>
        </FocusModalHeader>
        <FocusModalBody className="flex min-h-0 flex-col">
          <BackupHistoryTable
            backups={rows}
            canCreate={canCreate}
            canRestore={canRestore}
            emptyDescription="Run this schedule once, or wait for the next cron fire. Completed archives show up here with size and timing."
            emptyTitle="No backups yet"
            onRestore={onRestore}
            onView={setViewing}
            remove={remove}
          />
        </FocusModalBody>
      </FocusModalContent>

      <BackupRunDetailDialog
        backup={viewing}
        logLines={volumeRunLogs}
        onOpenChange={(next) => {
          if (!next) {
            setViewing(null);
          }
        }}
        open={viewing !== null}
        title="Volume backup run"
      />
    </FocusModal>
  );
}
