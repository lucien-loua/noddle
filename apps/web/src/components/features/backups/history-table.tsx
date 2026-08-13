/**
 * biome-ignore-all lint/performance/noJsxPropsBind: table row actions;
 * per-row handlers need the backup instance from the map callback.
 */
import { ClipboardTextIcon } from "@phosphor-icons/react";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import type { BackupRunRow } from "./run-types";

export function BackupHistoryTable<T extends BackupRunRow>({
  backups,
  canCreate,
  canRestore,
  emptyDescription,
  emptyTitle,
  onRestore,
  onView,
  remove,
}: {
  backups: T[] | undefined;
  canCreate: boolean;
  canRestore?: boolean;
  emptyDescription: string;
  emptyTitle: string;
  onRestore?: (backup: T) => void;
  onView: (backup: T) => void;
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
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            <EmptyDescription>{emptyDescription}</EmptyDescription>
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
            const canRestoreRun =
              Boolean(canRestore && onRestore) && backup.status === "completed";
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
                    {canRestoreRun && onRestore ? (
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
