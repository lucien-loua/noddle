/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import {
  ClipboardTextIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { FramePanel } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { databaseBackupSubject } from "@/lib/backup-subject";
import { errorMessage } from "@/lib/format";
import { mutations } from "@/lib/mutations";
import { cn } from "@/lib/utils";
import { type BackupConfigRow, deleteBackupConfig } from "@/server/backups";

export function BackupConfigCard({
  canCreate,
  config,
  onDeleted,
  onEdit,
  onHistory,
}: {
  canCreate: boolean;
  config: BackupConfigRow;
  onDeleted: () => void;
  onEdit: () => void;
  onHistory: () => void;
}) {
  const queryClient = useQueryClient();
  const run = useMutation(
    mutations.triggerBackupRun(
      queryClient,
      databaseBackupSubject(config.databaseId),
      config.id
    )
  );
  const remove = useMutation({
    mutationFn: () => deleteBackupConfig({ data: { configId: config.id } }),
    onError: (err) =>
      toast.add({
        description: errorMessage(err, "delete failed"),
        title: "Could not delete schedule",
        type: "error",
      }),
    onSuccess: () => {
      toast.add({ title: "Schedule deleted", type: "success" });
      onDeleted();
    },
  });

  const keepLatest =
    config.keepLatestCount === null
      ? "Keep all"
      : String(config.keepLatestCount);

  return (
    <FramePanel>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full",
                config.enabled ? "bg-success" : "bg-destructive"
              )}
            />
            <h2 className="font-semibold text-sm">
              {config.enabled ? "Active" : "Inactive"}
            </h2>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <Meta label="Destination" value={config.destinationName} />
            <Meta label="Database" value={config.databaseName} />
            <Meta label="Schedule" value={config.schedule} />
            <Meta label="Prefix" value={config.prefix || "—"} />
            <Meta label="Retention" value={keepLatest} />
          </dl>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="Dump history"
            onClick={onHistory}
            size="icon-sm"
            variant="ghost"
          >
            <ClipboardTextIcon />
          </Button>
          {canCreate ? (
            <Button
              aria-label="Run backup now"
              disabled={run.isPending}
              onClick={() => {
                run
                  .mutateAsync()
                  .then(() => {
                    toast.add({ title: "Backup queued", type: "success" });
                  })
                  .catch((err) => {
                    toast.add({
                      description: errorMessage(err, "backup failed"),
                      title: "Could not queue backup",
                      type: "error",
                    });
                  });
              }}
              size="icon-sm"
              variant="ghost"
            >
              {run.isPending ? <Spinner /> : <PlayIcon />}
            </Button>
          ) : null}
          {canCreate ? (
            <Button
              aria-label="Edit schedule"
              onClick={onEdit}
              size="icon-sm"
              variant="ghost"
            >
              <PencilSimpleIcon />
            </Button>
          ) : null}
          {canCreate ? (
            <Button
              aria-label="Delete schedule"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
              size="icon-sm"
              variant="ghost"
            >
              {remove.isPending ? <Spinner /> : <TrashIcon />}
            </Button>
          ) : null}
        </div>
      </div>
    </FramePanel>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate font-medium text-sm">{value}</dd>
    </div>
  );
}
