/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import {
  ArchiveIcon,
  CaretDownIcon,
  HardDrivesIcon,
  PlusIcon,
} from "@phosphor-icons/react";
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
    cache.volumeBackupConfigs(queryClient, serviceId).catch(() => undefined);
  }, [queryClient, serviceId]);

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
            <FrameTitle>Volume backups</FrameTitle>
            <FrameDescription>
              Tar Docker volumes on the server to S3 on a schedule.
            </FrameDescription>
          </div>
          {showHeaderActions ? (
            <VolumeBackupActions
              canRestore={canRestore}
              onCreate={() => setEditor("new")}
              onRestoreS3={() => {
                setDefaultVolumeName(rows[0]?.volumeName);
                setRestoreOpen(true);
              }}
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
            <ConfigsBody
              canCreate={canCreate}
              canRestore={canRestore}
              configsLoading={configs.isLoading}
              onCreate={() => setEditor("new")}
              onRestoreS3={() => setRestoreOpen(true)}
              rows={rows}
              serviceName={serviceName}
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
          Noddle needs somewhere to push volume archives before a schedule can
          run. Add one under{" "}
          <Link className="text-foreground underline" to="/destinations">
            S3 destinations
          </Link>
          .
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function VolumeBackupActions({
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
        Add volume backup
      </Button>
    );
  }

  return (
    <ButtonGroup>
      <Button onClick={onCreate} size="sm" variant="outline">
        <PlusIcon data-icon="inline-start" />
        Add volume backup
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="icon-sm" variant="outline">
              <CaretDownIcon />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onRestoreS3}>
            Restore volume backup
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
  onCreate,
  onRestoreS3,
  rows,
  serviceName,
}: {
  canCreate: boolean;
  canRestore: boolean;
  configsLoading: boolean;
  onCreate: () => void;
  onRestoreS3: () => void;
  rows: VolumeBackupConfigRow[];
  serviceName: string;
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
            <HardDrivesIcon className="size-5" weight="duotone" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No volume backups</EmptyTitle>
          <EmptyDescription>
            Nothing archives volumes for {serviceName} yet. Add a schedule, or
            restore from an archive already sitting in a destination.
          </EmptyDescription>
        </EmptyHeader>
        {canCreate ? (
          <EmptyContent className="flex flex-row flex-wrap gap-2">
            <Button onClick={onCreate}>
              <PlusIcon data-icon="inline-start" />
              Add volume backup
            </Button>
            {canRestore ? (
              <Button onClick={onRestoreS3} variant="outline">
                Restore volume backup
              </Button>
            ) : null}
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }

  return null;
}
