/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { ArchiveIcon, CaretDownIcon, PlusIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { IconStack } from "@/components/icon-stack";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
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
    cache.backupConfigs(queryClient, databaseId).catch(() => undefined);
  }, [databaseId, queryClient]);

  if (destinations.length === 0) {
    return <NoDestinationEmpty />;
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
            <BackupActions
              canRestore={canRestore}
              onCreate={() => setEditor("new")}
              onRestoreS3={() => setRestoreOpen(true)}
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
            <ConfigsBody
              canCreate={canCreate}
              canRestore={canRestore}
              configsLoading={configs.isLoading}
              databaseName={databaseName}
              onCreate={() => setEditor("new")}
              onRestoreS3={() => setRestoreOpen(true)}
              rows={rows}
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
          config={historyConfig}
          databaseId={databaseId}
          onOpenChange={(open) => {
            if (!open) {
              setHistoryConfig(null);
            }
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

function NoDestinationEmpty() {
  return (
    <Empty>
      <EmptyMedia>
        <IconStack>
          <ArchiveIcon className="size-5" weight="duotone" />
        </IconStack>
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No S3 destination</EmptyTitle>
        <EmptyDescription>
          Noddle needs somewhere to push dumps before a schedule can run. Add
          one under{" "}
          <Link className="text-foreground underline" to="/destinations">
            S3 destinations
          </Link>
          .
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function BackupActions({
  canRestore,
  onCreate,
  onRestoreS3,
}: {
  canRestore: boolean;
  onCreate: () => void;
  onRestoreS3: () => void;
}) {
  if (!canRestore) {
    return (
      <Button onClick={onCreate} size="sm" variant="outline">
        <PlusIcon data-icon="inline-start" />
        Add schedule
      </Button>
    );
  }

  return (
    <ButtonGroup>
      <Button onClick={onCreate} size="sm" variant="outline">
        <PlusIcon data-icon="inline-start" />
        Add schedule
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="icon-sm" variant="outline">
              <CaretDownIcon />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={onRestoreS3}>
            Restore dump
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

function ConfigsBody({
  canCreate,
  canRestore,
  configsLoading,
  databaseName,
  onCreate,
  onRestoreS3,
  rows,
}: {
  canCreate: boolean;
  canRestore: boolean;
  configsLoading: boolean;
  databaseName: string;
  onCreate: () => void;
  onRestoreS3: () => void;
  rows: BackupConfigRow[];
}) {
  if (configsLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyMedia>
          <IconStack>
            <ArchiveIcon className="size-5" weight="duotone" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No schedules yet</EmptyTitle>
          <EmptyDescription>
            Nothing dumps {databaseName} on a cadence yet. Add a schedule, or
            restore from a dump already sitting in a destination.
          </EmptyDescription>
        </EmptyHeader>
        {canCreate ? (
          <EmptyContent className="flex flex-row flex-wrap gap-2">
            <Button onClick={onCreate}>
              <PlusIcon data-icon="inline-start" />
              Add schedule
            </Button>
            {canRestore ? (
              <Button onClick={onRestoreS3} variant="outline">
                Restore dump
              </Button>
            ) : null}
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }

  return null;
}
