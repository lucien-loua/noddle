/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { ArchiveIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ConfigsListBody } from "@/components/features/backup-shared/configs-list-body";
import { NoDestinationEmpty } from "@/components/features/backup-shared/no-destination-empty";
import { ScheduleActions } from "@/components/features/backup-shared/schedule-actions";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { databaseBackupSubject } from "@/lib/backup-subject";
import { cache } from "@/lib/cache";
import { queries } from "@/lib/queries";
import type { BackupConfigRow, DestinationRow } from "@/server/backups";
import { BackupConfigCard } from "./backup-config-card";
import { BackupConfigDialog } from "./backup-config-dialog";
import { BackupHistoryDialog } from "./backup-history";
import { RestoreFromS3Dialog } from "./restore-from-s3-dialog";
import type { RestoreTarget } from "./types";

interface Props {
  canCreate: boolean;
  canRestore: boolean;
  databaseId: string;
  databaseName: string;
  /** Prefill for the schedule form (engine DB name or resource name). */
  defaultDatabaseName: string;
  destinations: DestinationRow[];
  onRestore: (target: RestoreTarget) => void;
}

export function BackupPanel({
  canCreate,
  canRestore,
  databaseId,
  databaseName,
  defaultDatabaseName,
  destinations,
  onRestore,
}: Props) {
  const queryClient = useQueryClient();
  const configs = useQuery(queries.backupConfigs(databaseId));

  const [editor, setEditor] = useState<BackupConfigRow | "new" | null>(null);
  const [historyConfig, setHistoryConfig] = useState<BackupConfigRow | null>(
    null
  );
  const [restoreOpen, setRestoreOpen] = useState(false);

  const invalidate = useCallback(() => {
    cache
      .backupConfigsFor(queryClient, databaseBackupSubject(databaseId))
      .catch(() => undefined);
  }, [databaseId, queryClient]);

  if (destinations.length === 0) {
    return (
      <NoDestinationEmpty description="Noddle needs somewhere to push dumps before a schedule can run. Add one under" />
    );
  }

  const rows = configs.data ?? [];
  const showHeaderActions = rows.length > 0 && canCreate;
  const listReady = !(configs.isLoading || rows.length === 0);

  return (
    <div className="space-y-3">
      <Frame className="w-full" variant="ghost">
        <FrameHeader className="flex-row items-center justify-between gap-3">
          <div className="min-w-0">
            <FrameTitle>Backups</FrameTitle>
            <FrameDescription>
              Dump this database to S3 on a schedule.
            </FrameDescription>
          </div>
          {showHeaderActions ? (
            <ScheduleActions
              canRestore={canRestore}
              createLabel="Add schedule"
              onCreate={() => setEditor("new")}
              onRestoreS3={() => setRestoreOpen(true)}
              restoreLabel="Restore dump"
            />
          ) : null}
        </FrameHeader>
        {listReady ? (
          rows.map((config) => (
            <BackupConfigCard
              canCreate={canCreate}
              config={config}
              key={config.id}
              onDeleted={invalidate}
              onEdit={() => setEditor(config)}
              onHistory={() => setHistoryConfig(config)}
            />
          ))
        ) : (
          <FramePanel>
            <ConfigsListBody
              canCreate={canCreate}
              canRestore={canRestore}
              configsLoading={configs.isLoading}
              createLabel="Add schedule"
              emptyDescription={`Nothing dumps ${databaseName} on a cadence yet. Add a schedule, or restore from a dump already sitting in a destination.`}
              emptyIcon={ArchiveIcon}
              emptyTitle="No schedules yet"
              onCreate={() => setEditor("new")}
              onRestoreS3={() => setRestoreOpen(true)}
              restoreLabel="Restore dump"
              rowCount={rows.length}
            />
          </FramePanel>
        )}
      </Frame>

      {editor ? (
        <BackupConfigDialog
          databaseId={databaseId}
          defaultDatabaseName={defaultDatabaseName}
          destinations={destinations}
          editing={editor === "new" ? null : editor}
          onOpenChange={(open) => {
            if (!open) {
              setEditor(null);
            }
          }}
          onSaved={() => {
            setEditor(null);
            invalidate();
          }}
          open
        />
      ) : null}

      {historyConfig ? (
        <BackupHistoryDialog
          canCreate={canCreate}
          canRestore={canRestore}
          config={historyConfig}
          databaseId={databaseId}
          onOpenChange={(open) => {
            if (!open) {
              setHistoryConfig(null);
            }
          }}
          onRestore={(backup) => {
            setHistoryConfig(null);
            onRestore({ backup, kind: "run" });
          }}
          open
        />
      ) : null}

      {restoreOpen ? (
        <RestoreFromS3Dialog
          destinations={destinations}
          onOpenChange={setRestoreOpen}
          onPick={(destinationId, objectKey) => {
            setRestoreOpen(false);
            onRestore({ destinationId, kind: "object", objectKey });
          }}
          open
        />
      ) : null}
    </div>
  );
}
