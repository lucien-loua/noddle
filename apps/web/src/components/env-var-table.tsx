// Variables d'environnement : tableau éditable en ligne, diff AVANT
// enregistrement.
//
// Le diff n'est pas une politesse. Ces valeurs partent dans un conteneur en
// production au prochain déploiement ; une clé d'API écrasée par une faute de
// frappe se découvre quand l'application tombe. On montre donc ce qui va
// changer, et on demande confirmation.
//
// Ce que le tableau ne sait PAS : la valeur d'un secret. Une server function
// ne la renvoie jamais. Pour un secret, le diff peut donc dire « modifiée »,
// jamais « de X à Y » — et c'est la bonne limite.
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { ChangeEvent } from "react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  /** Identifiant local, stable pendant l'édition. */
  uid: string;
  /** `null` = valeur inchangée côté serveur (cas d'un secret non retouché). */
  value: string | null;
}

interface Props {
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
 * Ce qui sera réellement écrit, comparé à ce qui est en base.
 *
 * Calculé sur l'état chargé, pas re-demandé au serveur : c'est le même
 * administrateur seul devant sa machine, et un aller-retour de plus rendrait
 * le diff moins immédiat sans le rendre plus vrai.
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
  return value === null || value === "" ? "(vide)" : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cellules
//
// Chacune est un composant plutôt qu'une fermeture dans le rendu du tableau :
// c'est le seul moyen de tenir un gestionnaire stable, puisqu'il doit lier
// l'identifiant de sa ligne.
// ─────────────────────────────────────────────────────────────────────────────

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
      // Un secret déjà enregistré arrive avec `value: null`. Le placeholder dit
      // qu'il y a bien quelque chose sans le montrer ; taper le remplace, ne
      // rien taper le laisse.
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
      aria-label={`Retirer ${row.key}`}
      onClick={handleClick}
      size="icon-sm"
      variant="ghost"
    >
      <TrashIcon />
    </Button>
  );
}

const columnHelper = createColumnHelper<DraftVar>();

export function EnvVarTable({ onSave, pending, saved }: Props) {
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

  // Deux temps volontairement : « Enregistrer » montre l'intention, un second
  // clic l'exécute. Le diff est juste au-dessus, donc il est lu entre les deux.
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
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-medium text-sm">Environment variables</h2>
        <Button onClick={addRow} size="sm" variant="outline">
          <PlusIcon data-icon="inline-start" />
          Add variable
        </Button>
      </div>

      {draft.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No environment variables yet.
        </p>
      ) : (
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
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {changes.length > 0 ? (
        <div className="mt-4 rounded-lg border border-ring bg-muted/40 p-3">
          <h3 className="mb-2 font-medium text-sm">
            {changes.length} change{changes.length > 1 ? "s" : ""} to save
          </h3>

          <div className="flex flex-col gap-0.5">
            {changes.map((change) => (
              <div
                className="flex items-baseline gap-2 font-mono text-xs"
                key={`${change.kind}-${change.key}`}
              >
                <span
                  className={cn(
                    "w-[1ch] shrink-0 font-bold",
                    change.kind === "add" && "text-success",
                    change.kind === "remove" && "text-destructive"
                  )}
                >
                  {MARKS[change.kind]}
                </span>
                <span className="min-w-0 break-all">
                  <strong>{change.key}</strong>{" "}
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

          <div className="mt-3 flex items-center gap-2">
            <Button disabled={pending} onClick={commit} size="sm">
              {confirming ? "Confirm save" : "Save"}
            </Button>

            <Button onClick={reset} size="sm" variant="ghost">
              Cancel
            </Button>

            <span className="text-muted-foreground text-xs">
              Takes effect on the next deploy.
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
