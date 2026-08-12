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
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  deleteVolumeBackupConfig,
  triggerVolumeBackup,
  type VolumeBackupConfigRow,
} from "@/server/volume-backups";

export function VolumeBackupConfigCard({
  canCreate,
  config,
  onDeleted,
  onEdit,
  onHistory,
}: {
  canCreate: boolean;
  config: VolumeBackupConfigRow;
  onDeleted: () => void;
  onEdit: () => void;
  onHistory: () => void;
}) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => triggerVolumeBackup({ data: { configId: config.id } }),
    onError: (err) =>
      toast.add({
        description: errorMessage(err, "backup failed"),
        title: "Could not queue volume backup",
        type: "error",
      }),
    onSuccess: async () => {
      toast.add({ title: "Volume backup queued", type: "success" });
      await cache.volumeBackups(queryClient, config.serviceId, config.id);
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      deleteVolumeBackupConfig({ data: { configId: config.id } }),
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
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <Meta label="Destination" value={config.destinationName} />
            <Meta label="Volume" value={config.volumeName} />
            <Meta label="Schedule" value={config.schedule} />
            <Meta label="Prefix" value={config.prefix || "—"} />
            <Meta label="Retention" value={keepLatest} />
            <Meta label="Mount path" value={config.mountPath ?? "—"} />
          </dl>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="Backup history"
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
              onClick={() => run.mutate()}
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
