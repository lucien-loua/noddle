/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { copyFor } from "@/components/features/backups/copy";
import { BackupHistoryTable } from "@/components/features/backups/history-table";
import { BackupRunDetailDialog } from "@/components/features/backups/run-detail-dialog";
import {
  databaseRunLogs,
  volumeRunLogs,
} from "@/components/features/backups/run-logs";
import type { BackupRunRow } from "@/components/features/backups/run-types";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import type { BackupSubject } from "@/lib/backup-subject";
import { mutations } from "@/lib/mutations";
import { queries } from "@/lib/queries";

const POLL_MS = 3000;
/** How many runs the history drawer lists. */
const HISTORY_LIMIT = 10;

export function BackupHistoryDialog({
  canCreate,
  canRestore,
  configId,
  onOpenChange,
  onRestore,
  open,
  subject,
}: {
  canCreate: boolean;
  canRestore?: boolean;
  configId: string;
  onOpenChange: (open: boolean) => void;
  onRestore?: (backup: BackupRunRow) => void;
  open: boolean;
  subject: BackupSubject;
}) {
  const copy = copyFor(subject.kind);
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<BackupRunRow | null>(null);
  const backups = useQuery({
    ...queries.backupRunsFor(subject, configId),
    refetchInterval: (query) =>
      query.state.data?.some(
        (b) => b.status === "queued" || b.status === "running"
      )
        ? POLL_MS
        : false,
  });

  const remove = useMutation(
    mutations.deleteBackupRun(queryClient, subject, configId)
  );

  const rows = backups.isLoading
    ? undefined
    : (backups.data ?? []).slice(0, HISTORY_LIMIT);

  return (
    <FocusModal onOpenChange={onOpenChange} open={open}>
      <FocusModalContent>
        <FocusModalHeader>
          <FocusModalTitle>{copy.historyTitle}</FocusModalTitle>
        </FocusModalHeader>
        <FocusModalBody className="flex min-h-0 flex-col">
          <BackupHistoryTable
            backups={rows}
            canCreate={canCreate}
            canRestore={canRestore}
            emptyDescription={copy.emptyHistoryDescription}
            emptyIcon={copy.emptyIcon}
            emptyTitle={copy.emptyHistoryTitle}
            onRestore={onRestore}
            onView={setViewing}
            remove={remove}
          />
        </FocusModalBody>
      </FocusModalContent>

      <BackupRunDetailDialog
        backup={viewing}
        logLines={subject.kind === "database" ? databaseRunLogs : volumeRunLogs}
        onOpenChange={(next) => {
          if (!next) {
            setViewing(null);
          }
        }}
        open={viewing !== null}
        title={copy.runTitle}
      />
    </FocusModal>
  );
}
