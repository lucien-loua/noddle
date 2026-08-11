/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { BACKUP_CRON_PRESETS } from "@noddle/shared/validation";
import {
  ArchiveIcon,
  ClipboardTextIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { useAppForm } from "@/components/fields/lib/form";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import {
  formatLogStamp,
  type TerminalLogLine,
  TerminalLogs,
} from "@/components/terminal-logs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalDescription,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import {
  backupKindLabel,
  backupLabel,
  badgeVariant,
  byteSize,
  duration,
  errorMessage,
  relativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  type BackupConfigRow,
  type BackupObjectRow,
  type BackupRow,
  createBackupConfig,
  type DestinationRow,
  deleteBackup,
  deleteBackupConfig,
  getBackups,
  listBackupConfigs,
  listBackupObjects,
  triggerBackup,
  updateBackupConfig,
} from "@/server/backups";

const POLL_MS = 3000;
const DEFAULT_CRON = "0 0 * * *";
/** How many runs the history drawer lists. */
const HISTORY_LIMIT = 10;

type ScheduleMode = (typeof BACKUP_CRON_PRESETS)[number]["cron"] | "custom";

type RestoreTarget =
  | { backup: BackupRow; kind: "run" }
  | { kind: "object"; objectKey: string; destinationId: string };

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

function isPresetCron(value: string): value is Exclude<ScheduleMode, "custom"> {
  return BACKUP_CRON_PRESETS.some((p) => p.cron === value);
}

function scheduleModeFor(schedule: string): ScheduleMode {
  return isPresetCron(schedule) ? schedule : "custom";
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
  const configs = useQuery({
    queryFn: () => listBackupConfigs({ data: { databaseId } }),
    queryKey: ["backup-configs", databaseId],
  });

  const [editor, setEditor] = useState<BackupConfigRow | "new" | null>(null);
  const [historyConfig, setHistoryConfig] = useState<BackupConfigRow | null>(
    null
  );
  const [restoreOpen, setRestoreOpen] = useState(false);

  const invalidate = useCallback(() => {
    queryClient
      .invalidateQueries({
        queryKey: ["backup-configs", databaseId],
      })
      .catch(() => undefined);
  }, [databaseId, queryClient]);

  if (destinations.length === 0) {
    return <NoDestinationEmpty />;
  }

  const rows = configs.data ?? [];
  const showHeaderActions = rows.length > 0 && canCreate;

  return (
    <div className="space-y-3">
      <Frame variant="ghost">
        <FrameHeader className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <FrameTitle>Backups</FrameTitle>
            <FrameDescription>
              Scheduled dumps of this database into an S3 destination. You can
              keep several schedules — different buckets, prefixes, or cadences.
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
        <FramePanel>
          <ConfigsBody
            canCreate={canCreate}
            canRestore={canRestore}
            configsLoading={configs.isLoading}
            databaseName={databaseName}
            onCreate={() => setEditor("new")}
            onDeleted={invalidate}
            onEdit={setEditor}
            onHistory={setHistoryConfig}
            onRestoreS3={() => setRestoreOpen(true)}
            rows={rows}
          />
        </FramePanel>
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
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button onClick={onCreate} size="sm">
        <PlusIcon data-icon="inline-start" />
        Add schedule
      </Button>
      {canRestore ? (
        <Button onClick={onRestoreS3} size="sm" variant="outline">
          Restore dump
        </Button>
      ) : null}
    </div>
  );
}

function ConfigsBody({
  canCreate,
  canRestore,
  configsLoading,
  databaseName,
  onCreate,
  onDeleted,
  onEdit,
  onHistory,
  onRestoreS3,
  rows,
}: {
  canCreate: boolean;
  canRestore: boolean;
  configsLoading: boolean;
  databaseName: string;
  onCreate: () => void;
  onDeleted: () => void;
  onEdit: (config: BackupConfigRow) => void;
  onHistory: (config: BackupConfigRow) => void;
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

  return (
    <div className="flex flex-col gap-3">
      {rows.map((config) => (
        <BackupConfigCard
          canCreate={canCreate}
          config={config}
          key={config.id}
          onDeleted={onDeleted}
          onEdit={() => onEdit(config)}
          onHistory={() => onHistory(config)}
        />
      ))}
    </div>
  );
}

function BackupConfigCard({
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
  const run = useMutation({
    mutationFn: () => triggerBackup({ data: { configId: config.id } }),
    onError: (err) =>
      toast.add({
        description: errorMessage(err, "backup failed"),
        title: "Could not queue backup",
        type: "error",
      }),
    onSuccess: () => {
      toast.add({ title: "Backup queued", type: "success" });
      queryClient
        .invalidateQueries({
          queryKey: ["backups", config.databaseId, config.id],
        })
        .catch(() => undefined);
    },
  });
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
    <div className="flex flex-col gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/50 md:flex-row md:items-start md:justify-between">
      <div className="flex w-full flex-col gap-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-1.5 rounded-full",
              config.enabled ? "bg-emerald-500" : "bg-red-500"
            )}
          />
          <span className="text-muted-foreground text-xs">
            {config.enabled ? "On" : "Paused"}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <Meta label="Destination" value={config.destinationName} />
          <Meta label="Database" value={config.databaseName} />
          <Meta label="Schedule" value={config.schedule} />
          <Meta label="Prefix" value={config.prefix || "—"} />
          <Meta label="Retention" value={keepLatest} />
        </div>
      </div>
      <div className="flex flex-row gap-1 md:flex-col">
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
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-30">
      <span className="font-medium text-muted-foreground text-sm">{label}</span>
      <p className="mt-0.5 font-medium text-sm">{value}</p>
    </div>
  );
}

function configFormDefaults(
  editing: BackupConfigRow | null,
  defaultDatabaseName: string,
  fallbackDestinationId: string
) {
  if (editing) {
    return {
      databaseName: editing.databaseName,
      destinationId: editing.destinationId,
      enabled: editing.enabled,
      keepLatestCount:
        editing.keepLatestCount === null ? "" : String(editing.keepLatestCount),
      prefix: editing.prefix,
      schedule: editing.schedule,
    };
  }
  return {
    databaseName: defaultDatabaseName,
    destinationId: fallbackDestinationId,
    enabled: true,
    keepLatestCount: "",
    prefix: "",
    schedule: DEFAULT_CRON,
  };
}

function BackupConfigDialog({
  databaseId,
  defaultDatabaseName,
  destinations,
  editing,
  onOpenChange,
  onSaved,
  open,
}: {
  databaseId: string;
  defaultDatabaseName: string;
  destinations: DestinationRow[];
  editing: BackupConfigRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
}) {
  const [firstDestination] = destinations;
  const fallbackDestinationId = firstDestination ? firstDestination.id : "";
  const defaults = configFormDefaults(
    editing,
    defaultDatabaseName,
    fallbackDestinationId
  );
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    scheduleModeFor(defaults.schedule)
  );

  const form = useAppForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      try {
        const keepRaw = value.keepLatestCount.trim();
        const keepLatestCount =
          keepRaw === "" ? null : Number.parseInt(keepRaw, 10);
        if (keepLatestCount !== null && !Number.isFinite(keepLatestCount)) {
          throw new Error("Keep latest must be a number");
        }
        const payload = {
          databaseName: value.databaseName,
          destinationId: value.destinationId,
          enabled: value.enabled,
          keepLatestCount,
          prefix: value.prefix,
          schedule: value.schedule.trim(),
        };
        if (editing) {
          await updateBackupConfig({
            data: { ...payload, configId: editing.id },
          });
        } else {
          await createBackupConfig({
            data: { ...payload, databaseId },
          });
        }
        toast.add({
          title: editing ? "Schedule updated" : "Schedule added",
          type: "success",
        });
        onSaved();
      } catch (err) {
        toast.add({
          description: errorMessage(err, "could not save schedule"),
          title: "Could not save schedule",
          type: "error",
        });
        throw err;
      }
    },
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    form.reset();
    setScheduleMode(scheduleModeFor(defaults.schedule));
  }, [open, form.reset, defaults.schedule]);

  if (!fallbackDestinationId) {
    return null;
  }

  const selectedDestination =
    destinations.find((d) => d.id === form.state.values.destinationId) ?? null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit schedule" : "Add schedule"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes apply to the next run. A dump already in flight keeps its original settings."
              : "How often Noddle should dump this database, and which destination receives the file."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form.AppForm>
            <FieldGroup>
              <Field>
                <FieldLabel>Destination</FieldLabel>
                <Combobox
                  items={destinations}
                  itemToStringLabel={(d: DestinationRow) => d.name}
                  itemToStringValue={(d: DestinationRow) => d.name}
                  onValueChange={(next) => {
                    if (!next) {
                      form.setFieldValue("destinationId", "");
                      return;
                    }
                    form.setFieldValue(
                      "destinationId",
                      (next as DestinationRow).id
                    );
                  }}
                  value={selectedDestination}
                >
                  <ComboboxInput placeholder="Choose a destination" />
                  <ComboboxContent>
                    <ComboboxEmpty>No destination matches.</ComboboxEmpty>
                    <ComboboxList>
                      {(d: DestinationRow) => (
                        <ComboboxItem key={d.id} value={d}>
                          {d.name}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </Field>

              <form.AppField name="databaseName">
                {(f) => (
                  <f.FieldText
                    description="Name inside the engine that the dumper targets."
                    label="Database name"
                  />
                )}
              </form.AppField>

              <Field>
                <FieldLabel>Schedule</FieldLabel>
                <Select
                  onValueChange={(v) => {
                    const next = String(v) as ScheduleMode;
                    setScheduleMode(next);
                    if (next !== "custom") {
                      form.setFieldValue("schedule", next);
                    }
                  }}
                  value={scheduleMode}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a cadence" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {BACKUP_CRON_PRESETS.map((p) => (
                        <SelectItem key={p.cron} value={p.cron}>
                          {p.label} ({p.cron})
                        </SelectItem>
                      ))}
                      <SelectItem value="custom">Custom cron</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {scheduleMode === "custom" ? (
                  <form.AppField name="schedule">
                    {(f) => (
                      <f.FieldText
                        label="Cron expression"
                        placeholder={DEFAULT_CRON}
                      />
                    )}
                  </form.AppField>
                ) : null}
                <FieldDescription>
                  Five-field cron in UTC. The worker checks due schedules every
                  few minutes.
                </FieldDescription>
              </Field>

              <form.AppField name="prefix">
                {(f) => (
                  <f.FieldText
                    description="Appended under the destination prefix in the bucket. Leave empty to use the destination alone."
                    label="Object prefix"
                  />
                )}
              </form.AppField>

              <form.AppField name="keepLatestCount">
                {(f) => (
                  <f.FieldText
                    description="Leave empty to keep every dump. A number prunes older ones after each successful run."
                    label="Retention"
                    placeholder="Keep all"
                  />
                )}
              </form.AppField>

              <form.AppField name="enabled">
                {(f) => (
                  <Field>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={f.state.value}
                        onCheckedChange={(checked) =>
                          f.handleChange(checked === true)
                        }
                      />
                      <FieldLabel className="font-normal">
                        Run on schedule
                      </FieldLabel>
                    </div>
                    <FieldDescription>
                      When off, Noddle ignores this cadence until you turn it
                      back on. Manual runs still work.
                    </FieldDescription>
                  </Field>
                )}
              </form.AppField>
            </FieldGroup>
          </form.AppForm>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          <Button
            disabled={form.state.isSubmitting}
            onClick={() => form.handleSubmit()}
          >
            {form.state.isSubmitting ? <Spinner /> : null}
            {editing ? "Save changes" : "Add schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackupHistoryBody({
  backups,
  canCreate,
  onView,
  remove,
}: {
  backups: BackupRow[] | undefined;
  canCreate: boolean;
  onView: (backup: BackupRow) => void;
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
            <EmptyTitle>No dumps yet</EmptyTitle>
            <EmptyDescription>
              Run this schedule once, or wait for the next cron fire. Completed
              dumps show up here with size and timing.
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

function backupRunLogs(backup: BackupRow): TerminalLogLine[] {
  const start = formatLogStamp(backup.createdAt);
  const end = formatLogStamp(backup.finishedAt ?? backup.createdAt);
  const texts: string[] = [
    `${start} Starting backup process...`,
    `${start} Executing backup command...`,
  ];

  if (backup.status === "completed") {
    texts.push(
      `${end} Starting backup and upload to S3...`,
      `${end} ✅ Backup uploaded to S3 successfully`,
      `${end} Object: ${backup.objectKey} (${byteSize(backup.sizeBytes)})`,
      "Backup done ✅"
    );
  } else if (backup.status === "failed") {
    texts.push(
      `${end} ❌ Error: Backup failed`,
      `Error: ${backup.errorMessage ?? "unknown error"}`
    );
  } else if (backup.status === "running") {
    texts.push(`${start} Starting backup and upload to S3...`);
  } else {
    texts.push(`${start} Waiting to start...`);
  }

  return texts.map((text, index) => ({ id: String(index), text }));
}

function BackupRunDetailDialog({
  backup,
  onOpenChange,
  open,
}: {
  backup: BackupRow | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const lines = backup ? backupRunLogs(backup) : [];
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
                  <FocusModalTitle>Dump run</FocusModalTitle>
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

function BackupHistoryDialog({
  canCreate,
  config,
  databaseId,
  onOpenChange,
  open,
}: {
  canCreate: boolean;
  config: BackupConfigRow;
  databaseId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<BackupRow | null>(null);
  const backups = useQuery({
    queryFn: () => getBackups({ data: { configId: config.id, databaseId } }),
    queryKey: ["backups", databaseId, config.id],
    refetchInterval: (query) =>
      query.state.data?.some(
        (b) => b.status === "queued" || b.status === "running"
      )
        ? POLL_MS
        : false,
  });

  const remove = useMutation({
    mutationFn: (backupId: string) => deleteBackup({ data: { backupId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["backups", databaseId, config.id],
      }),
  });

  const rows = backups.isLoading
    ? undefined
    : (backups.data ?? []).slice(0, HISTORY_LIMIT);

  return (
    <FocusModal onOpenChange={onOpenChange} open={open}>
      <FocusModalContent>
        <FocusModalHeader>
          <FocusModalTitle>Dump history</FocusModalTitle>
        </FocusModalHeader>
        <FocusModalBody className="flex min-h-0 flex-col">
          <BackupHistoryBody
            backups={rows}
            canCreate={canCreate}
            onView={setViewing}
            remove={remove}
          />
        </FocusModalBody>
      </FocusModalContent>

      {/* Nested under the history Root so Base UI wires Escape,
          focus, and `data-nested-dialog-open` / `--nested-dialogs`. */}
      <BackupRunDetailDialog
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

function ObjectsListBody({
  destinationId,
  error,
  isError,
  isLoading,
  objects,
  onPick,
}: {
  destinationId: string;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
  objects: BackupObjectRow[] | undefined;
  onPick: (destinationId: string, objectKey: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {errorMessage(error, "could not list objects")}
        </AlertDescription>
      </Alert>
    );
  }

  const rows = objects ?? [];
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No dump objects under this destination prefix.
      </p>
    );
  }

  return (
    <div className="min-w-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Modified</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((obj) => (
            <TableRow key={obj.key}>
              <TableCell className="max-w-70 truncate font-mono text-xs">
                {obj.key}
              </TableCell>
              <TableCell className="text-xs tabular-nums">
                {byteSize(obj.sizeBytes)}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {obj.lastModified ? relativeTime(obj.lastModified) : "—"}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  onClick={() => onPick(destinationId, obj.key)}
                  size="sm"
                  variant="outline"
                >
                  Restore
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RestoreFromS3Dialog({
  destinations,
  onOpenChange,
  onPick,
  open,
}: {
  destinations: DestinationRow[];
  onOpenChange: (open: boolean) => void;
  onPick: (destinationId: string, objectKey: string) => void;
  open: boolean;
}) {
  const [firstDestination] = destinations;
  const [destinationId, setDestinationId] = useState(
    firstDestination ? firstDestination.id : ""
  );
  const objects = useQuery({
    enabled: open && Boolean(destinationId),
    queryFn: () => listBackupObjects({ data: { destinationId } }),
    queryKey: ["backup-objects", destinationId],
  });

  const selected = destinations.find((d) => d.id === destinationId) ?? null;

  return (
    <FocusModal onOpenChange={onOpenChange} open={open}>
      <FocusModalContent>
        <FocusModalHeader>
          <div className="min-w-0">
            <FocusModalTitle>Restore from destination</FocusModalTitle>
            <FocusModalDescription>
              Pick a dump already in the bucket. Noddle takes a safety dump
              first so the restore stays reversible.
            </FocusModalDescription>
          </div>
        </FocusModalHeader>
        <FocusModalBody className="flex min-h-0 flex-col gap-4 overflow-hidden p-4">
          <Field className="shrink-0">
            <FieldLabel>Destination</FieldLabel>
            <Combobox
              items={destinations}
              itemToStringLabel={(d: DestinationRow) => d.name}
              itemToStringValue={(d: DestinationRow) => d.name}
              onValueChange={(next) => {
                if (!next) {
                  setDestinationId("");
                  return;
                }
                setDestinationId((next as DestinationRow).id);
              }}
              value={selected}
            >
              <ComboboxInput placeholder="Choose a destination" />
              <ComboboxContent>
                <ComboboxEmpty>No destination matches.</ComboboxEmpty>
                <ComboboxList>
                  {(d: DestinationRow) => (
                    <ComboboxItem key={d.id} value={d}>
                      {d.name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </Field>

          <div className="scroll-fade-y no-scrollbar min-h-0 flex-1 overflow-y-auto">
            <ObjectsListBody
              destinationId={destinationId}
              error={objects.error}
              isError={objects.isError}
              isLoading={objects.isLoading}
              objects={objects.data}
              onPick={onPick}
            />
          </div>
        </FocusModalBody>
      </FocusModalContent>
    </FocusModal>
  );
}

/**
 * The restore confirmation.
 *
 * It asks for the name to be typed in by hand, and that's not an
 * ornament: the server refuses the request if the name doesn't match.
 */
export function RestoreDialog({
  databaseName,
  onConfirm,
  onOpenChange,
  pending,
  target,
}: {
  databaseName: string;
  onConfirm: (confirmName: string) => void;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  target: RestoreTarget | null;
}) {
  const description =
    target?.kind === "run" ? (
      <>
        The live data in this database will be{" "}
        <strong>permanently replaced</strong> by the dump taken{" "}
        {relativeTime(target.backup.createdAt)}. Noddle writes a safety dump
        first, so you can undo the restore if needed.
      </>
    ) : (
      <>
        The live data in this database will be{" "}
        <strong>permanently replaced</strong> by
        {target ? (
          <>
            {" "}
            <code className="text-xs">{target.objectKey}</code>
          </>
        ) : (
          " the selected dump"
        )}
        . Noddle writes a safety dump first.
      </>
    );

  return (
    <ConfirmNameDialog
      confirmLabel="Restore database"
      description={description}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={target !== null}
      pending={pending}
      resourceName={databaseName}
      title={`Restore ${databaseName}?`}
    />
  );
}

export type { RestoreTarget };
