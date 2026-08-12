/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BackupHistoryTable } from "@/components/features/backup-shared/history-table";
import { BackupRunDetailDialog } from "@/components/features/backup-shared/run-detail-dialog";
import { databaseRunLogs } from "@/components/features/backup-shared/run-logs";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { databaseBackupSubject } from "@/lib/backup-subject";
import { mutations } from "@/lib/mutations";
import { queries } from "@/lib/queries";
import type { BackupConfigRow, BackupRow } from "@/server/backups";

const POLL_MS = 3000;
/** How many runs the history drawer lists. */
const HISTORY_LIMIT = 10;

export function BackupHistoryDialog({
  canCreate,
  canRestore,
  config,
  databaseId,
  onOpenChange,
  onRestore,
  open,
}: {
  canCreate: boolean;
  canRestore?: boolean;
  config: BackupConfigRow;
  databaseId: string;
  onOpenChange: (open: boolean) => void;
  onRestore?: (backup: BackupRow) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<BackupRow | null>(null);
  const subject = databaseBackupSubject(databaseId);
  const backups = useQuery({
    ...queries.backups(databaseId, config.id),
    refetchInterval: (query) =>
      query.state.data?.some(
        (b) => b.status === "queued" || b.status === "running"
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
          <FocusModalTitle>Dump history</FocusModalTitle>
        </FocusModalHeader>
        <FocusModalBody className="flex min-h-0 flex-col">
          <BackupHistoryTable
            backups={rows}
            canCreate={canCreate}
            canRestore={canRestore}
            emptyDescription="Run this schedule once, or wait for the next cron fire. Completed dumps show up here with size and timing."
            emptyTitle="No dumps yet"
            onRestore={onRestore}
            onView={setViewing}
            remove={remove}
          />
        </FocusModalBody>
      </FocusModalContent>

      <BackupRunDetailDialog
        backup={viewing}
        logLines={databaseRunLogs}
        onOpenChange={(next) => {
          if (!next) {
            setViewing(null);
          }
        }}
        open={viewing !== null}
        title="Dump run"
      />
    </FocusModal>
  );
}
