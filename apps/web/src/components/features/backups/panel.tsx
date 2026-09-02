import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { BackupConfigCard } from "@/components/features/backups/config-card";
import { BackupConfigDialog } from "@/components/features/backups/config-dialog";
import { ConfigsListBody } from "@/components/features/backups/configs-list-body";
import { copyFor } from "@/components/features/backups/copy";
import { BackupHistoryDialog } from "@/components/features/backups/history";
import { NoDestinationEmpty } from "@/components/features/backups/no-destination-empty";
import { RestoreFromS3Dialog } from "@/components/features/backups/restore-from-s3-dialog";
import type { BackupRestoreTarget } from "@/components/features/backups/restore-types";
import { ScheduleActions } from "@/components/features/backups/schedule-actions";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { backupSubjectScopeId } from "@/lib/backup-subject";
import type {
  BackupSubject,
  DatabaseBackupSubject,
  VolumeBackupSubject,
} from "@/lib/backup-subject";
import { cache } from "@/lib/cache";
import { queries } from "@/lib/queries";
import type { BackupConfigRow } from "@/server/backups/configs";
import type { DestinationRow } from "@/server/backups/destinations";
import type { VolumeBackupConfigRow } from "@/server/backups/volume/configs";

type ScheduleRow = BackupConfigRow | VolumeBackupConfigRow;

interface DatabasePanelProps {
  canCreate: boolean;
  canRestore: boolean;
  defaultDatabaseName: string;
  destinations: DestinationRow[];
  onRestore: (target: BackupRestoreTarget) => void;
  resourceName: string;
  subject: DatabaseBackupSubject;
}

interface VolumePanelProps {
  canCreate: boolean;
  canRestore: boolean;
  destinations: DestinationRow[];
  onRestore: (target: BackupRestoreTarget) => void;
  resourceName: string;
  subject: VolumeBackupSubject;
}

type BackupPanelProps = DatabasePanelProps | VolumePanelProps;

function isDatabasePanel(props: BackupPanelProps): props is DatabasePanelProps {
  return props.subject.kind === "database";
}

function extraMeta(row: ScheduleRow) {
  if ("databaseName" in row) {
    return [{ label: "Database", value: row.databaseName }];
  }
  return [
    { label: "Volume", value: row.volumeName },
    { label: "Mount path", value: row.mountPath ?? "—" },
  ];
}

function defaultVolumeNameFor(subject: BackupSubject, rows: ScheduleRow[]) {
  if (subject.kind !== "volume") {
    return;
  }
  const [first] = rows;
  return first && "volumeName" in first ? first.volumeName : undefined;
}

export function BackupPanel(props: BackupPanelProps) {
  const {
    canCreate,
    canRestore,
    destinations,
    onRestore,
    resourceName,
    subject,
  } = props;
  const copy = copyFor(subject.kind);
  const queryClient = useQueryClient();
  const configs = useQuery(queries.backupConfigsFor(subject));

  const [editor, setEditor] = useState<ScheduleRow | "new" | null>(null);
  const [historyConfig, setHistoryConfig] = useState<ScheduleRow | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const invalidate = useCallback(() => {
    cache.backupConfigsFor(queryClient, subject).catch(() => {});
  }, [queryClient, subject.kind, backupSubjectScopeId(subject)]);

  if (destinations.length === 0) {
    return <NoDestinationEmpty description={copy.noDestination} />;
  }

  const rows = configs.data ?? [];
  const showHeaderActions = rows.length > 0 && canCreate;
  const listReady = !(configs.isLoading || rows.length === 0);

  return (
    <>
      {listReady ? (
        <Frame className="w-full" variant="ghost">
          <FrameHeader className="flex-row items-center justify-between gap-3">
            <div className="min-w-0">
              <FrameTitle>{copy.title}</FrameTitle>
              <FrameDescription>{copy.description}</FrameDescription>
            </div>
            {showHeaderActions ? (
              <ScheduleActions
                canRestore={canRestore}
                createIcon={copy.emptyIcon}
                createLabel={copy.createLabel}
                onCreate={() => setEditor("new")}
                onRestoreS3={() => setRestoreOpen(true)}
                restoreLabel={copy.restoreLabel}
              />
            ) : null}
          </FrameHeader>
          {rows.map((config) => (
            <BackupConfigCard
              canCreate={canCreate}
              config={{
                destinationName: config.destinationName,
                enabled: config.enabled,
                extra: extraMeta(config),
                id: config.id,
                keepLatestCount: config.keepLatestCount,
                prefix: config.prefix,
                schedule: config.schedule,
              }}
              key={config.id}
              onDeleted={invalidate}
              onEdit={() => setEditor(config)}
              onHistory={() => setHistoryConfig(config)}
              subject={subject}
            />
          ))}
        </Frame>
      ) : (
        <Frame className="flex h-full min-h-0 flex-1 flex-col" variant="ghost">
          <FramePanel className="flex min-h-0 flex-1 flex-col">
            <ConfigsListBody
              canCreate={canCreate}
              canRestore={canRestore}
              configsLoading={configs.isLoading}
              createLabel={copy.createLabel}
              emptyDescription={copy.emptyDescription(resourceName)}
              emptyIcon={copy.emptyIcon}
              emptyTitle={copy.emptyTitle}
              onCreate={() => setEditor("new")}
              onRestoreS3={() => setRestoreOpen(true)}
              restoreLabel={copy.restoreLabel}
              rowCount={rows.length}
            />
          </FramePanel>
        </Frame>
      )}

      {editor && isDatabasePanel(props) ? (
        <BackupConfigDialog
          defaultDatabaseName={props.defaultDatabaseName}
          destinations={destinations}
          editing={editor === "new" ? null : (editor as BackupConfigRow)}
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
          subject={props.subject}
        />
      ) : null}

      {editor && !isDatabasePanel(props) ? (
        <BackupConfigDialog
          destinations={destinations}
          editing={editor === "new" ? null : (editor as VolumeBackupConfigRow)}
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
          subject={props.subject}
        />
      ) : null}

      {historyConfig ? (
        <BackupHistoryDialog
          canCreate={canCreate}
          canRestore={canRestore}
          configId={historyConfig.id}
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
          subject={subject}
        />
      ) : null}

      {restoreOpen ? (
        <RestoreFromS3Dialog
          defaultVolumeName={defaultVolumeNameFor(subject, rows)}
          destinations={destinations}
          onOpenChange={setRestoreOpen}
          onPick={(target) => {
            setRestoreOpen(false);
            onRestore(target);
          }}
          open
          subject={subject}
        />
      ) : null}
    </>
  );
}
