import {
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { ChangeEvent, ClipboardEvent } from "react";
import { useCallback, useMemo, useState } from "react";

import { useCopyFeedback } from "@/components/copyable-value";
import { DatabaseMark } from "@/components/features/database/database-mark";
import { useReveal } from "@/components/features/database/reveal-secret";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { EnvVarAttachment, EnvVarView } from "@/server/env-vars";

import { EnvImportDialog } from "./import-dialog";
import { parseEnvPaste, shouldInterceptEnvPaste } from "./parse-env-paste";
import type { EnvPair } from "./parse-env-paste";

export interface DraftVar {
  /** The database this variable came from, when attaching wrote it.
   *  Carried into the draft so the linked mark survives editing the row. */
  attachedFrom: EnvVarAttachment | null;
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
  /** Persistent footer copy — lives in the Frame, not an Alert above it. */
  note?: string;
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
type PasteFn = (uid: string, pairs: EnvPair[]) => void;

const MARKS: Record<ChangeKind, string> = {
  add: "+",
  change: "~",
  remove: "−",
};

/**
 * Merges an imported file into the draft: a key already in the table keeps
 * its place and takes the new value, the rest lands above the trailing blank
 * row. Replacing the table wholesale would silently drop variables the file
 * does not mention.
 */
function mergeEnvPairs(rows: DraftVar[], pairs: EnvPair[]): DraftVar[] {
  let next = rows;
  for (const pair of pairs) {
    const at = next.findIndex((row) => row.key === pair.key);
    if (at === -1) {
      next = [
        ...next.filter((row) => !isBlank(row)),
        {
          attachedFrom: null,
          isSecret: true,
          key: pair.key,
          uid: crypto.randomUUID(),
          value: pair.value,
        },
      ];
      continue;
    }
    next = next.map((row, i) =>
      i === at ? { ...row, value: pair.value } : row
    );
  }
  return ensureBlank(next);
}

function blankRow(): DraftVar {
  return {
    attachedFrom: null,
    isSecret: true,
    key: "",
    uid: crypto.randomUUID(),
    value: "",
  };
}

function isBlank(row: DraftVar): boolean {
  return row.key.length === 0 && (row.value === null || row.value.length === 0);
}

function ensureBlank(rows: DraftVar[]): DraftVar[] {
  const last = rows.at(-1);
  if (last && isBlank(last)) {
    return rows;
  }
  return [...rows, blankRow()];
}

function toDraft(rows: EnvVarView[]): DraftVar[] {
  return ensureBlank(
    rows.map((row) => ({
      attachedFrom: row.attachedFrom,
      isSecret: row.isSecret,
      key: row.key,
      uid: row.id,
      value: row.value,
    }))
  );
}

/**
 * Fill the focused row with the first pair, then insert the rest below —
 * the Vercel paste: a whole `.env` blob becomes rows, not one giant value.
 */
function applyEnvPaste(
  rows: DraftVar[],
  uid: string,
  pairs: EnvPair[]
): DraftVar[] {
  if (pairs.length === 0) {
    return rows;
  }

  const next = [...rows];
  const index = next.findIndex((row) => row.uid === uid);
  if (index === -1) {
    return rows;
  }

  const [first, ...rest] = pairs;
  const current = next[index];
  if (!(first && current)) {
    return rows;
  }

  next[index] = { ...current, key: first.key, value: first.value };

  let insertAt = index + 1;
  for (const pair of rest) {
    const existing = next.findIndex(
      (row, rowIndex) => rowIndex !== index && row.key === pair.key
    );
    const existingRow = existing === -1 ? undefined : next[existing];
    if (existingRow) {
      next[existing] = {
        ...existingRow,
        key: pair.key,
        value: pair.value,
      };
      continue;
    }
    next.splice(insertAt, 0, {
      attachedFrom: null,
      isSecret: true,
      key: pair.key,
      uid: crypto.randomUUID(),
      value: pair.value,
    });
    insertAt += 1;
  }

  return ensureBlank(next);
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

/**
 * The diff shows values, masked no longer.
 *
 * The mask followed a per-row flag that no longer exists, and a diff of
 * `•••••• → ••••••` cannot do the one job it has: letting you see what you
 * are about to write before you write it. This appears only after clicking
 * Save, on values the same table reveals in one click.
 */
function display(value: string | null): string {
  return value === null || value === "" ? "(empty)" : value;
}

function KeyCell({
  onPasteEnv,
  onUpdate,
  row,
}: {
  onPasteEnv: PasteFn;
  onUpdate: UpdateFn;
  row: DraftVar;
}) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) =>
      onUpdate(row.uid, { key: e.target.value }),
    [onUpdate, row.uid]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData("text");
      if (!shouldInterceptEnvPaste(text, "key", row.key)) {
        return;
      }
      e.preventDefault();
      onPasteEnv(row.uid, parseEnvPaste(text));
    },
    [onPasteEnv, row.key, row.uid]
  );

  return (
    <Input
      aria-label="Variable name"
      className="h-8 font-mono text-xs"
      onChange={handleChange}
      onPaste={handlePaste}
      placeholder="VARIABLE_NAME"
      spellCheck={false}
      value={row.key}
    />
  );
}

function LinkedCell({ attachment }: { attachment: EnvVarAttachment | null }) {
  if (!attachment) {
    return (
      <span className="inline-flex size-8 items-center justify-center text-muted-foreground">
        <KeyIcon aria-hidden className="size-4" weight="regular" />
        <span className="sr-only">Typed variable</span>
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label={`Open ${attachment.name}`}
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
            params={{
              databaseId: attachment.databaseId,
              environmentId: attachment.environmentId,
              projectId: attachment.projectId,
            }}
            to="/projects/$projectId/$environmentId/databases/$databaseId"
          />
        }
      >
        <DatabaseMark className="size-4" engine={attachment.engine} size="xs" />
      </TooltipTrigger>
      <TooltipContent>
        Connection string from attaching {attachment.name}
      </TooltipContent>
    </Tooltip>
  );
}

function ValueCell({
  onPasteEnv,
  onUpdate,
  row,
}: {
  onPasteEnv: PasteFn;
  onUpdate: UpdateFn;
  row: DraftVar;
}) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) =>
      onUpdate(row.uid, { value: e.target.value }),
    [onUpdate, row.uid]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData("text");
      if (!shouldInterceptEnvPaste(text, "value", row.key)) {
        return;
      }
      e.preventDefault();
      onPasteEnv(row.uid, parseEnvPaste(text));
    },
    [onPasteEnv, row.key, row.uid]
  );

  const { revealed, toggle } = useReveal();
  const { copied, handleCopy } = useCopyFeedback(row.value ?? "");

  return (
    <InputGroup className="h-8">
      <InputGroupInput
        aria-label="Value"
        className="font-mono text-xs"
        onChange={handleChange}
        onPaste={handlePaste}
        placeholder="value"
        spellCheck={false}
        // Hidden by DEFAULT, every row, not only the ones someone thought to
        // tick. A production table read over a shoulder or on a shared screen
        // does not get to depend on that.
        type={revealed ? "text" : "password"}
        value={row.value ?? ""}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          aria-label={revealed ? "Hide the value" : "Reveal the value"}
          onClick={toggle}
          size="icon-xs"
        >
          {revealed ? (
            <EyeSlashIcon weight="regular" />
          ) : (
            <EyeIcon weight="regular" />
          )}
        </InputGroupButton>
        <InputGroupButton
          aria-label={`Copy ${row.key || "the value"}`}
          disabled={!row.value}
          onClick={handleCopy}
          size="icon-xs"
        >
          {copied ? (
            <CheckIcon weight="regular" />
          ) : (
            <CopyIcon weight="regular" />
          )}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
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

export function EnvVarTable({ effect, note, onSave, pending, saved }: Props) {
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
    setDraft((rows) => ensureBlank(rows.filter((row) => row.uid !== uid)));
    setConfirming(false);
  }, []);

  const addRow = useCallback(() => {
    setDraft((rows) => [...rows, blankRow()]);
    setConfirming(false);
  }, []);

  const importEnv = useCallback((pairs: EnvPair[]) => {
    setDraft((rows) => mergeEnvPairs(rows, pairs));
    setConfirming(false);
  }, []);

  const pasteEnv = useCallback<PasteFn>((uid, pairs) => {
    setDraft((rows) => applyEnvPaste(rows, uid, pairs));
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
      columnHelper.display({
        cell: (info) => (
          <LinkedCell attachment={info.row.original.attachedFrom} />
        ),
        header: () => <span className="sr-only">Linked</span>,
        id: "linked",
      }),
      columnHelper.accessor("key", {
        cell: (info) => (
          <KeyCell
            onPasteEnv={pasteEnv}
            onUpdate={update}
            row={info.row.original}
          />
        ),
        header: "Key",
      }),
      columnHelper.accessor("value", {
        cell: (info) => (
          <ValueCell
            onPasteEnv={pasteEnv}
            onUpdate={update}
            row={info.row.original}
          />
        ),
        header: "Value",
      }),
      columnHelper.display({
        cell: (info) => (
          <RemoveCell onRemove={remove} row={info.row.original} />
        ),
        header: "",
        id: "actions",
      }),
    ],
    [pasteEnv, remove, update]
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
        <div className="flex shrink-0 items-center gap-2">
          <EnvImportDialog onImport={importEnv} />
          <Button onClick={addRow} size="sm" variant="outline">
            <PlusIcon data-icon="inline-start" weight="regular" />
            Add variable
          </Button>
        </div>
      </FrameHeader>
      <FramePanel className="p-0">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    className={
                      header.column.id === "linked" ? "w-0 pe-0" : undefined
                    }
                    key={header.id}
                  >
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
                  <TableCell
                    className={
                      cell.column.id === "linked" ? "w-0 pe-0" : undefined
                    }
                    key={cell.id}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </FramePanel>
      {note || changes.length > 0 ? (
        <FrameFooter className="gap-3">
          {note ? (
            <p className="text-muted-foreground text-xs">{note}</p>
          ) : null}

          {changes.length > 0 ? (
            <>
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
                          ? `${display(change.before)} → ${display(change.after)}`
                          : display(
                              change.kind === "remove"
                                ? change.before
                                : change.after
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
            </>
          ) : null}
        </FrameFooter>
      ) : null}
    </Frame>
  );
}
