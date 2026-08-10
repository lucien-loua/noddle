import { ArchiveIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useState } from "react";
import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  errorMessage,
  relativeTime,
} from "@/lib/format";
import {
  type BackupRow,
  type DestinationRow,
  getBackups,
  saveBackupSchedule,
  triggerBackup,
} from "@/server/backups";

/**
 * While a backup is running, we keep polling. It takes seconds to minutes
 * depending on the database: without this the row would stay "Running"
 * until the user reloads, and they'd conclude it's stuck.
 */
const POLL_MS = 3000;

const SCHEDULES: { label: string; value: Schedule }[] = [
  { label: "Never", value: "off" },
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
];

type Schedule = "daily" | "off" | "weekly";

/**
 * The automatic schedule, as three buttons.
 *
 * Neither cron nor a time picker: "every day" is enough of an answer to the
 * question the user is asking, and the exact time isn't a setting until
 * someone has asked for it. Retention sits next to it because the two are
 * decided together — turning on a schedule without capping what you keep
 * is signing up for a storage bill that climbs on its own.
 */
function ScheduleControl({
  databaseId,
  destinations,
  retention,
  s3DestinationId,
  schedule,
}: {
  databaseId: string;
  destinations: DestinationRow[];
  retention: number;
  s3DestinationId: string | null;
  schedule: Schedule;
}) {
  const [value, setValue] = useState<Schedule>(schedule);
  const [keep, setKeep] = useState(String(retention));
  const [target, setTarget] = useState<string | null>(s3DestinationId);
  // `useId` and not a hardcoded identifier: nothing prevents two backup
  // panels on the same screen, and two identical `for` attributes would
  // only ever point to the first field.
  const keepId = useId();

  const save = useMutation({
    mutationFn: (next: {
      retention: number;
      s3DestinationId: string | null;
      schedule: Schedule;
    }) =>
      saveBackupSchedule({
        data: {
          databaseId,
          retention: next.retention,
          s3DestinationId: next.s3DestinationId,
          schedule: next.schedule,
        },
      }),
    // The toggle is optimistic so the click responds right away, so it MUST
    // be rolled back when the server refuses. Without this, a rejected save
    // — a schedule with no destination, for example — left "Daily" selected
    // while the database stayed on its old rhythm: the screen was claiming
    // a protection that didn't exist. Observed in an actual browser.
    onError: (_err, _next, context: { previous: Schedule } | undefined) => {
      if (context) {
        setValue(context.previous);
      }
    },
    onMutate: (next) => {
      const previous = value;
      setValue(next.schedule);
      return { previous };
    },
  });

  const handleSchedule = useCallback(
    (next: Schedule) => {
      save.mutate({
        retention: Number(keep) || 1,
        s3DestinationId: target,
        schedule: next,
      });
    },
    [keep, save, target]
  );

  // The selector only exists FROM TWO destinations onward. This preserves
  // the comfort of the old single-destination setup: an installation with
  // only one bucket is never asked the question.
  const handleTarget = useCallback(
    (next: unknown) => {
      const chosen = next === "" || typeof next !== "string" ? null : next;
      setTarget(chosen);
      save.mutate({
        retention: Number(keep) || 1,
        s3DestinationId: chosen,
        schedule: value,
      });
    },
    [keep, save, value]
  );

  // The combobox returns the chosen OBJECT, not its identifier: we
  // translate it back before reusing `handleTarget`, which remains the
  // single source of truth for writes.
  const selectedDestination = destinations.find((d) => d.id === target) ?? null;
  const handleTargetItem = useCallback(
    (next: unknown) => {
      const chosen = next as DestinationRow | null;
      handleTarget(chosen ? chosen.id : "");
    },
    [handleTarget]
  );

  const handleKeep = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setKeep(e.target.value),
    []
  );
  const handleKeepBlur = useCallback(() => {
    const n = Number(keep);
    if (Number.isInteger(n) && n >= 1 && n <= 100) {
      save.mutate({ retention: n, s3DestinationId: target, schedule: value });
    } else {
      setKeep(String(retention));
    }
  }, [keep, retention, save, target, value]);

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-3">
      <span className="text-muted-foreground text-xs">Automatic</span>
      <div className="flex gap-1">
        {SCHEDULES.map((option) => (
          <ScheduleButton
            active={value === option.value}
            key={option.value}
            label={option.label}
            onSelect={handleSchedule}
            value={option.value}
          />
        ))}
      </div>

      {value === "off" ? null : (
        <span className="flex items-center gap-2 text-muted-foreground text-xs">
          {/* The visible word IS the label, rather than an `aria-label`
              set alongside it: an accessible name that doesn't contain the
              visible text breaks voice control ("keeping" would point to
              nothing). The `sr-only` completes the sentence without
              repeating it on screen. */}
          <Label
            className="font-normal text-muted-foreground text-xs"
            htmlFor={keepId}
          >
            keeping
            <span className="sr-only">backups</span>
          </Label>
          <Input
            className="h-7 w-16 text-xs"
            id={keepId}
            inputMode="numeric"
            onBlur={handleKeepBlur}
            onChange={handleKeep}
            value={keep}
          />
        </span>
      )}

      {destinations.length > 1 ? (
        <span className="flex items-center gap-2 text-muted-foreground text-xs">
          to
          {/* A combobox here too: the number of destinations is no longer
              bounded now that we accept several. Constrained in width to
              stay within the sentence, unlike the form fields. */}
          <Combobox
            items={destinations}
            itemToStringLabel={destinationToName}
            itemToStringValue={destinationToName}
            onValueChange={handleTargetItem}
            value={selectedDestination}
          >
            <ComboboxInput
              aria-label="S3 destination"
              className="w-44"
              placeholder="pick one"
            />
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
        </span>
      ) : null}

      {save.isError ? (
        <span className="text-destructive text-xs">
          {errorMessage(save.error, "failed")}
        </span>
      ) : null}
    </div>
  );
}

function ScheduleButton({
  active,
  label,
  onSelect,
  value,
}: {
  active: boolean;
  label: string;
  onSelect: (value: Schedule) => void;
  value: Schedule;
}) {
  const handleClick = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Button
      onClick={handleClick}
      size="sm"
      variant={active ? "secondary" : "ghost"}
    >
      {label}
    </Button>
  );
}

interface Props {
  /** `backup:create` — also covers scheduling: setting an automatic rhythm
   *  without being able to trigger a manual backup wouldn't make sense. */
  canCreate: boolean;
  /** `backup:restore` — distinct from `canCreate`: an operator can back up
   *  but not restore, the product's only irreversible operation. */
  canRestore: boolean;
  databaseId: string;
  databaseName: string;
  /** All destinations of the installation. The selector only appears from
   *  two onward — see `ScheduleControl`. */
  destinations: DestinationRow[];
  onRestore: (backup: BackupRow) => void;
  retention: number;
  s3DestinationId: string | null;
  schedule: Schedule;
}

export function BackupPanel({
  canCreate,
  canRestore,
  databaseId,
  databaseName,
  destinations,
  onRestore,
  retention,
  s3DestinationId,
  schedule,
}: Props) {
  const queryClient = useQueryClient();

  const backups = useQuery({
    queryFn: () => getBackups({ data: { databaseId } }),
    queryKey: ["backups", databaseId],
    refetchInterval: (query) =>
      query.state.data?.some(
        (b) => b.status === "queued" || b.status === "running"
      )
        ? POLL_MS
        : false,
  });

  const run = useMutation({
    mutationFn: () => triggerBackup({ data: { databaseId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["backups", databaseId] }),
  });

  const handleBackup = useCallback(() => run.mutate(), [run]);

  const rows = backups.data ?? [];

  return (
    <div className="space-y-3">
      {run.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {errorMessage(run.error, "backup failed")}
          </AlertDescription>
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <Empty>
          <EmptyMedia>
            <IconStack>
              <ArchiveIcon className="size-5" weight="duotone" />
            </IconStack>
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No backups yet</EmptyTitle>
            <EmptyDescription>
              The first backup of {databaseName} will be restorable from this
              list.
            </EmptyDescription>
          </EmptyHeader>
          {canCreate ? (
            <EmptyContent>
              <Button disabled={run.isPending} onClick={handleBackup}>
                {run.isPending ? <Spinner /> : null}
                Back up now
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <Frame variant="ghost">
          <FrameHeader className="flex-row items-center justify-between gap-3">
            <div>
              <FrameTitle>Backups</FrameTitle>
              <FrameDescription>
                To this installation's S3 storage.
              </FrameDescription>
            </div>
            {canCreate ? (
              <Button disabled={run.isPending} onClick={handleBackup} size="sm">
                {run.isPending ? <Spinner /> : null}
                Back up now
              </Button>
            ) : null}
          </FrameHeader>
          <FramePanel className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Taken</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((backup) => (
                  <BackupLine
                    backup={backup}
                    canRestore={canRestore}
                    key={backup.id}
                    onRestore={onRestore}
                  />
                ))}
              </TableBody>
            </Table>
          </FramePanel>
        </Frame>
      )}

      {canCreate ? (
        <ScheduleControl
          databaseId={databaseId}
          destinations={destinations}
          retention={retention}
          s3DestinationId={s3DestinationId}
          schedule={schedule}
        />
      ) : null}
    </div>
  );
}

function BackupLine({
  backup,
  canRestore,
  onRestore,
}: {
  backup: BackupRow;
  canRestore: boolean;
  onRestore: (backup: BackupRow) => void;
}) {
  const status = backupLabel(backup.status);
  const handleRestore = useCallback(
    () => onRestore(backup),
    [backup, onRestore]
  );

  return (
    <TableRow>
      <TableCell>
        <Badge variant={badgeVariant(status.tone)}>{status.label}</Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {backupKindLabel(backup.kind)}
      </TableCell>
      <TableCell className="text-xs tabular-nums">
        {byteSize(backup.sizeBytes)}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">
        {duration(backup.createdAt, backup.finishedAt)}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        <RelativeTime iso={backup.createdAt} />
      </TableCell>
      <TableCell className="text-right">
        {/* Only a complete backup is restorable: a half-finished backup
            isn't an option we offer. The server re-checks this. */}
        {backup.status === "completed" && canRestore ? (
          <Button onClick={handleRestore} size="sm" variant="outline">
            Restore
          </Button>
        ) : (
          <span
            className="text-muted-foreground text-xs"
            title={backup.errorMessage ?? undefined}
          >
            {backup.errorMessage ? "see error" : "—"}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * The restore confirmation.
 *
 * It asks for the name to be typed in by hand, and that's not an
 * ornament: the server refuses the request if the name doesn't match. The
 * dialog makes the safeguard visible, it doesn't create it.
 */
export function RestoreDialog({
  backup,
  databaseName,
  onConfirm,
  onOpenChange,
  pending,
}: {
  backup: BackupRow | null;
  databaseName: string;
  onConfirm: (confirmName: string) => void;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
}) {
  return (
    <ConfirmNameDialog
      confirmLabel="Restore"
      description={
        <>
          The current data in this database will be{" "}
          <strong>permanently replaced</strong> by the backup
          {backup ? ` taken ${relativeTime(backup.createdAt)}` : ""}. Noddle
          automatically takes a safety backup just before, so the operation
          stays reversible.
        </>
      }
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={backup !== null}
      pending={pending}
      resourceName={databaseName}
      title={`Restore ${databaseName}?`}
    />
  );
}

/** What typing filters against in the destination selector. */
function destinationToName(destination: DestinationRow): string {
  return destination.name;
}
