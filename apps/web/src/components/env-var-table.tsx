import { PlusIcon, SlidersIcon, TrashIcon } from "@phosphor-icons/react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { ChangeEvent } from "react";
import { useCallback, useMemo, useState } from "react";
import { IconStack } from "@/components/icon-stack";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { EnvVarView } from "@/server/env-vars";

export interface DraftVar {
  isSecret: boolean;
  key: string;
  /** Local identifier, stable throughout editing. */
  uid: string;
  /** `null` = value unchanged on the server (the case of an untouched
   *  secret). */
  value: string | null;
}

interface Props {
  /** When the save takes effect. This is NOT the same sentence everywhere:
   *  a service applies its variables on the next deployment, a database
   *  restarts right away. The hardcoded text here used to contradict a
   *  database's screen, which announced a restart right above it. */
  effect: string;
  onSave: (vars: DraftVar[]) => void;
  pending: boolean;
  saved: EnvVarView[];
}

type ChangeKind = "add" | "change" | "remove";

interface Change {
  after: string | null;
  before: string | null;
  isSecret: boolean;
  key: string;
  kind: ChangeKind;
}

type UpdateFn = (uid: string, patch: Partial<DraftVar>) => void;
type RemoveFn = (uid: string) => void;

const MASK = "••••••••";

const MARKS: Record<ChangeKind, string> = {
  add: "+",
  change: "~",
  remove: "−",
};

function toDraft(rows: EnvVarView[]): DraftVar[] {
  return rows.map((row) => ({
    isSecret: row.isSecret,
    key: row.key,
    uid: row.id,
    value: row.value,
  }));
}

/**
 * What will actually be written, compared against what's in the database.
 *
 * Computed on the loaded state, not re-requested from the server: it's the
 * same admin alone in front of their machine, and one more round trip would
 * make the diff less immediate without making it more accurate.
 */
function diff(saved: EnvVarView[], draft: DraftVar[]): Change[] {
  const bySavedKey = new Map(saved.map((row) => [row.key, row]));
  const draftKeys = new Set(draft.map((d) => d.key));
  const changes: Change[] = [];

  for (const item of draft) {
    if (item.key.length === 0) {
      continue;
    }
    const previous = bySavedKey.get(item.key);

    if (!previous) {
      changes.push({
        after: item.value,
        before: null,
        isSecret: item.isSecret,
        key: item.key,
        kind: "add",
      });
      continue;
    }
    const valueChanged =
      item.value !== null && item.value !== (previous.value ?? null);
    if (valueChanged || previous.isSecret !== item.isSecret) {
      changes.push({
        after: item.value,
        before: previous.value,
        isSecret: item.isSecret || previous.isSecret,
        key: item.key,
        kind: "change",
      });
    }
  }

  for (const row of saved) {
    if (!draftKeys.has(row.key)) {
      changes.push({
        after: null,
        before: row.value,
        isSecret: row.isSecret,
        key: row.key,
        kind: "remove",
      });
    }
  }

  return changes;
}

function display(value: string | null, isSecret: boolean): string {
  if (isSecret) {
    return MASK;
  }
  return value === null || value === "" ? "(empty)" : value;
}

function KeyCell({ onUpdate, row }: { onUpdate: UpdateFn; row: DraftVar }) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) =>
      onUpdate(row.uid, { key: e.target.value }),
    [onUpdate, row.uid]
  );

  return (
    <Input
      aria-label="Variable name"
      className="h-8 font-mono text-xs"
      onChange={handleChange}
      placeholder="VARIABLE_NAME"
      spellCheck={false}
      value={row.key}
    />
  );
}

function ValueCell({ onUpdate, row }: { onUpdate: UpdateFn; row: DraftVar }) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) =>
      onUpdate(row.uid, { value: e.target.value }),
    [onUpdate, row.uid]
  );

  return (
    <Input
      aria-label="Value"
      className="h-8 font-mono text-xs"
      onChange={handleChange}
      placeholder={row.value === null ? MASK : ""}
      spellCheck={false}
      type={row.isSecret ? "password" : "text"}
      value={row.value ?? ""}
    />
  );
}

function SecretCell({ onUpdate, row }: { onUpdate: UpdateFn; row: DraftVar }) {
  const handleChange = useCallback(
    (checked: boolean | "indeterminate") =>
      onUpdate(row.uid, { isSecret: checked === true }),
    [onUpdate, row.uid]
  );

  return (
    <Checkbox
      aria-label="Mark as secret"
      checked={row.isSecret}
      onCheckedChange={handleChange}
    />
  );
}

function RemoveCell({ onRemove, row }: { onRemove: RemoveFn; row: DraftVar }) {
  const handleClick = useCallback(() => onRemove(row.uid), [onRemove, row.uid]);

  return (
    <Button
      aria-label={`Remove ${row.key}`}
      onClick={handleClick}
      size="icon-sm"
      variant="ghost"
    >
      <TrashIcon />
    </Button>
  );
}

const columnHelper = createColumnHelper<DraftVar>();

export function EnvVarTable({ effect, onSave, pending, saved }: Props) {
  const [draft, setDraft] = useState<DraftVar[]>(() => toDraft(saved));
  const [confirming, setConfirming] = useState(false);

  const changes = useMemo(() => diff(saved, draft), [saved, draft]);

  const update = useCallback<UpdateFn>((uid, patch) => {
    setDraft((rows) =>
      rows.map((row) => (row.uid === uid ? { ...row, ...patch } : row))
    );
    setConfirming(false);
  }, []);

  const remove = useCallback<RemoveFn>((uid) => {
    setDraft((rows) => rows.filter((row) => row.uid !== uid));
    setConfirming(false);
  }, []);

  const addRow = useCallback(() => {
    setDraft((rows) => [
      ...rows,
      { isSecret: false, key: "", uid: crypto.randomUUID(), value: "" },
    ]);
    setConfirming(false);
  }, []);

  const reset = useCallback(() => {
    setDraft(toDraft(saved));
    setConfirming(false);
  }, [saved]);

  const commit = useCallback(() => {
    if (confirming) {
      onSave(draft.filter((row) => row.key.length > 0));
      setConfirming(false);
      return;
    }
    setConfirming(true);
  }, [confirming, draft, onSave]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("key", {
        cell: (info) => <KeyCell onUpdate={update} row={info.row.original} />,
        header: "Key",
      }),
      columnHelper.accessor("value", {
        cell: (info) => <ValueCell onUpdate={update} row={info.row.original} />,
        header: "Value",
      }),
      columnHelper.accessor("isSecret", {
        cell: (info) => (
          <SecretCell onUpdate={update} row={info.row.original} />
        ),
        header: "Secret",
      }),
      columnHelper.display({
        cell: (info) => (
          <RemoveCell onRemove={remove} row={info.row.original} />
        ),
        header: "",
        id: "actions",
      }),
    ],
    [remove, update]
  );

  const table = useReactTable({
    columns,
    data: draft,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <Frame variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <FrameTitle>Environment variables</FrameTitle>
        <Button onClick={addRow} size="sm" variant="outline">
          <PlusIcon data-icon="inline-start" />
          Add variable
        </Button>
      </FrameHeader>

      {draft.length === 0 ? (
        <FramePanel>
          <Empty className="min-h-40">
            <EmptyHeader>
              <EmptyMedia>
                <IconStack>
                  <SlidersIcon className="size-5" weight="duotone" />
                </IconStack>
              </EmptyMedia>
              <EmptyTitle>No environment variables</EmptyTitle>
              <EmptyDescription>
                Add one to pass configuration without rebuilding.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </FramePanel>
      ) : (
        <FramePanel className="p-0">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </FramePanel>
      )}

      {changes.length > 0 ? (
        <FrameFooter className="gap-3">
          <div className="flex flex-col gap-1">
            {changes.map((change) => (
              <div
                className="flex items-center gap-2 font-mono text-xs"
                key={`${change.kind}-${change.key}`}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-sm font-bold",
                    change.kind === "add" && "bg-success/10 text-success",
                    change.kind === "remove" &&
                      "bg-destructive/10 text-destructive",
                    change.kind === "change" && "bg-muted text-foreground"
                  )}
                >
                  {MARKS[change.kind]}
                </span>
                <span className="min-w-0 break-all">
                  <strong className="font-semibold">{change.key}</strong>{" "}
                  <span
                    className={cn(
                      "text-muted-foreground",
                      change.kind === "remove" && "line-through"
                    )}
                  >
                    {change.kind === "change"
                      ? `${display(change.before, change.isSecret)} → ${display(change.after, change.isSecret)}`
                      : display(
                          change.kind === "remove"
                            ? change.before
                            : change.after,
                          change.isSecret
                        )}
                  </span>
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant="outline">
                {changes.length} change{changes.length > 1 ? "s" : ""}
              </Badge>
              <span className="truncate text-muted-foreground text-xs">
                {effect}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button onClick={reset} size="sm" variant="ghost">
                Cancel
              </Button>
              <Button disabled={pending} onClick={commit} size="sm">
                {pending ? <Spinner data-icon="inline-start" /> : null}
                {confirming ? "Confirm save" : "Save"}
              </Button>
            </div>
          </div>
        </FrameFooter>
      ) : null}
    </Frame>
  );
}
