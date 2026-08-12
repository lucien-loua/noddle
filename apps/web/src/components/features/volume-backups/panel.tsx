/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { HardDrivesIcon } from "@phosphor-icons/react";
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
import { volumeBackupSubject } from "@/lib/backup-subject";
import { cache } from "@/lib/cache";
import { queries } from "@/lib/queries";
import type { DestinationRow } from "@/server/backups";
import type {
  VolumeBackupConfigRow,
  VolumeBackupRow,
} from "@/server/volume-backups";
import { VolumeBackupConfigCard } from "./config-card";
import { VolumeBackupConfigDialog } from "./config-dialog";
import { VolumeBackupHistoryDialog } from "./history";
import { VolumeRestoreFromS3Dialog } from "./restore-from-s3-dialog";
import type { VolumeRestoreTarget } from "./types";

interface Props {
  canCreate: boolean;
  canRestore: boolean;
  destinations: DestinationRow[];
  onRestore: (target: VolumeRestoreTarget) => void;
  serviceId: string;
  serviceName: string;
}

export function VolumeBackupPanel({
  canCreate,
  canRestore,
  destinations,
  onRestore,
  serviceId,
  serviceName,
}: Props) {
  const queryClient = useQueryClient();
  const configs = useQuery(queries.volumeBackupConfigs(serviceId));

  const [editor, setEditor] = useState<VolumeBackupConfigRow | "new" | null>(
    null
  );
  const [historyConfig, setHistoryConfig] =
    useState<VolumeBackupConfigRow | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [defaultVolumeName, setDefaultVolumeName] = useState<
    string | undefined
  >();

  const invalidate = useCallback(() => {
    cache
      .backupConfigsFor(queryClient, volumeBackupSubject(serviceId))
      .catch(() => undefined);
  }, [queryClient, serviceId]);

  if (destinations.length === 0) {
    return (
      <NoDestinationEmpty description="Noddle needs somewhere to push volume archives before a schedule can run. Add one under" />
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
            <FrameTitle>Volume backups</FrameTitle>
            <FrameDescription>
              Tar Docker volumes on the server to S3 on a schedule.
            </FrameDescription>
          </div>
          {showHeaderActions ? (
            <ScheduleActions
              canRestore={canRestore}
              createLabel="Add volume backup"
              onCreate={() => setEditor("new")}
              onRestoreS3={() => {
                setDefaultVolumeName(rows[0]?.volumeName);
                setRestoreOpen(true);
              }}
              restoreLabel="Restore volume backup"
            />
          ) : null}
        </FrameHeader>
        {listReady ? (
          rows.map((config) => (
            <VolumeBackupConfigCard
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
              createLabel="Add volume backup"
              emptyDescription={`Nothing archives volumes for ${serviceName} yet. Add a schedule, or restore from an archive already sitting in a destination.`}
              emptyIcon={HardDrivesIcon}
              emptyTitle="No volume backups"
              onCreate={() => setEditor("new")}
              onRestoreS3={() => setRestoreOpen(true)}
              restoreLabel="Restore volume backup"
              rowCount={rows.length}
            />
          </FramePanel>
        )}
      </Frame>

      {editor ? (
        <VolumeBackupConfigDialog
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
          serviceId={serviceId}
        />
      ) : null}

      {historyConfig ? (
        <VolumeBackupHistoryDialog
          canCreate={canCreate}
          canRestore={canRestore}
          config={historyConfig}
          onOpenChange={(open) => {
            if (!open) {
              setHistoryConfig(null);
            }
          }}
          onRestore={(backup: VolumeBackupRow) => {
            setHistoryConfig(null);
            onRestore({ backup, kind: "run" });
          }}
          open
          serviceId={serviceId}
        />
      ) : null}

      {restoreOpen ? (
        <VolumeRestoreFromS3Dialog
          defaultVolumeName={defaultVolumeName}
          destinations={destinations}
          onOpenChange={setRestoreOpen}
          onPick={(destinationId, objectKey, volumeName) => {
            setRestoreOpen(false);
            onRestore({
              destinationId,
              kind: "object",
              objectKey,
              volumeName,
            });
          }}
          open
          serviceId={serviceId}
        />
      ) : null}
    </div>
  );
}
