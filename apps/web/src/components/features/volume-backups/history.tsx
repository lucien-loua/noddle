/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { ClipboardTextIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import {
  formatLogStamp,
  type TerminalLogLine,
  TerminalLogs,
} from "@/components/terminal-logs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalDescription,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  backupKindLabel,
  backupLabel,
  badgeVariant,
  byteSize,
  duration,
} from "@/lib/format";
import { mutations } from "@/lib/mutations";
import { queries } from "@/lib/queries";
import type {
  VolumeBackupConfigRow,
  VolumeBackupRow,
} from "@/server/volume-backups";

const POLL_MS = 3000;
const HISTORY_LIMIT = 10;

function VolumeBackupHistoryBody({
  backups,
  canCreate,
  canRestore,
  onRestore,
  onView,
  remove,
}: {
  backups: VolumeBackupRow[] | undefined;
  canCreate: boolean;
  canRestore: boolean;
  onRestore: (backup: VolumeBackupRow) => void;
  onView: (backup: VolumeBackupRow) => void;
  remove: {
    isPending: boolean;
    mutate: (backupId: string) => void;
  };
}) {
  if (!backups) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (backups.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 p-4">
        <Empty className="min-h-0 min-w-0 flex-1">
          <EmptyMedia>
            <IconStack>
              <ClipboardTextIcon className="size-5" weight="duotone" />
            </IconStack>
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No backups yet</EmptyTitle>
            <EmptyDescription>
              Run this schedule once, or wait for the next cron fire. Completed
              archives show up here with size and timing.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="min-w-0 p-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {backups.map((backup) => {
            const status = backupLabel(backup.status);
            const canDelete =
              canCreate &&
              backup.status !== "queued" &&
              backup.status !== "running";
            const canRestoreRun = canRestore && backup.status === "completed";
            return (
              <TableRow key={backup.id}>
                <TableCell>
                  <Badge variant={badgeVariant(status.tone)}>
                    {status.label}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {backupKindLabel(backup.kind)}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {backup.status === "completed"
                    ? byteSize(backup.sizeBytes)
                    : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  <RelativeTime iso={backup.createdAt} />
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {duration(backup.createdAt, backup.finishedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      onClick={() => onView(backup)}
                      size="sm"
                      variant="outline"
                    >
                      View
                    </Button>
                    {canRestoreRun ? (
                      <Button
                        onClick={() => onRestore(backup)}
                        size="sm"
                        variant="outline"
                      >
                        Restore
                      </Button>
                    ) : null}
                    {canDelete ? (
                      <Button
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(backup.id)}
                        size="sm"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function volumeRunLogs(backup: VolumeBackupRow): TerminalLogLine[] {
  const start = formatLogStamp(backup.createdAt);
  const end = formatLogStamp(backup.finishedAt ?? backup.createdAt);
  const texts: string[] = [
    `${start} Starting volume backup...`,
    `${start} Executing tar on the Docker volume...`,
  ];

  if (backup.status === "completed") {
    texts.push(
      `${end} Uploading archive to S3...`,
      `${end} ✅ Volume backup uploaded successfully`,
      `${end} Object: ${backup.objectKey} (${byteSize(backup.sizeBytes)})`,
      "Backup done ✅"
    );
  } else if (backup.status === "failed") {
    texts.push(
      `${end} ❌ Error: Volume backup failed`,
      `Error: ${backup.errorMessage ?? "unknown error"}`
    );
  } else if (backup.status === "running") {
    texts.push(`${start} Uploading archive to S3...`);
  } else {
    texts.push(`${start} Waiting to start...`);
  }

  return texts.map((text, index) => ({ id: String(index), text }));
}

function VolumeRunDetailDialog({
  backup,
  onOpenChange,
  open,
}: {
  backup: VolumeBackupRow | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const lines = backup ? volumeRunLogs(backup) : [];
  const status = backup ? backupLabel(backup.status) : null;
  const runMeta = backup
    ? [
        backupKindLabel(backup.kind),
        backup.status === "completed" ? byteSize(backup.sizeBytes) : null,
        duration(backup.createdAt, backup.finishedAt),
      ]
        .filter((part): part is string => Boolean(part) && part !== "—")
        .join(" · ")
    : "";

  return (
    <FocusModal onOpenChange={onOpenChange} open={open && backup !== null}>
      <FocusModalContent>
        {backup && status ? (
          <TerminalLogs lines={lines}>
            <FocusModalHeader>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <FocusModalTitle>Volume backup run</FocusModalTitle>
                  {runMeta ? (
                    <FocusModalDescription>{runMeta}</FocusModalDescription>
                  ) : null}
                </div>
                <Badge variant={badgeVariant(status.tone)}>
                  {status.label}
                </Badge>
                <ButtonGroup>
                  <ButtonGroupText>
                    {lines.length === 1 ? "1 line" : `${lines.length} lines`}
                  </ButtonGroupText>
                  <TerminalLogs.Copy label="logs" />
                </ButtonGroup>
              </div>
            </FocusModalHeader>
            <FocusModalBody className="flex min-h-0 flex-col overflow-hidden p-0">
              <div className="scroll-fade no-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                {lines.length === 0 ? (
                  <span className="text-muted-foreground text-sm">
                    No logs for this run.
                  </span>
                ) : (
                  lines.map((line) => (
                    <TerminalLogs.Line key={line.id} line={line} />
                  ))
                )}
              </div>
            </FocusModalBody>
          </TerminalLogs>
        ) : null}
      </FocusModalContent>
    </FocusModal>
  );
}

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
    mutations.deleteVolumeBackup(queryClient, serviceId, config.id)
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
          <VolumeBackupHistoryBody
            backups={rows}
            canCreate={canCreate}
            canRestore={canRestore}
            onRestore={onRestore}
            onView={setViewing}
            remove={remove}
          />
        </FocusModalBody>
      </FocusModalContent>

      <VolumeRunDetailDialog
        backup={viewing}
        onOpenChange={(next) => {
          if (!next) {
            setViewing(null);
          }
        }}
        open={viewing !== null}
      />
    </FocusModal>
  );
}
