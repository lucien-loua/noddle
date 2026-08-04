// Les sauvegardes d'une base : le bouton, l'historique, la restauration.
//
// L'historique ressemble à celui d'un déploiement, mais l'action de droite ne
// s'y comporte PAS pareil, et c'est délibéré. Rejouer une image ne détruit
// rien — la précédente existe toujours. Restaurer écrase des données que rien
// ne ramène. Donc « Restaurer » passe par une confirmation qui demande le nom
// de la base à la main, et Noddle prend de lui-même une sauvegarde de sûreté
// juste avant, ce qui rend l'opération réversible pour de bon.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
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
  relativeTime,
} from "@/lib/format";
import { type BackupRow, getBackups, triggerBackup } from "@/server/backups";

/**
 * Tant qu'une sauvegarde tourne, on resonde. Elle dure des secondes à des
 * minutes selon la base : sans ça la ligne resterait « En cours » jusqu'à ce
 * que l'utilisateur recharge, et il conclurait que c'est bloqué.
 */
const POLL_MS = 3000;

interface Props {
  databaseId: string;
  databaseName: string;
  onRestore: (backup: BackupRow) => void;
}

export function BackupPanel({ databaseId, databaseName, onRestore }: Props) {
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
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          Vers le stockage S3 de l'installation.
        </p>
        <Button disabled={run.isPending} onClick={handleBackup} size="sm">
          {run.isPending ? <Spinner /> : null}
          Sauvegarder
        </Button>
      </div>

      {run.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {run.error instanceof Error
              ? run.error.message
              : "sauvegarde impossible"}
          </AlertDescription>
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <Empty>
          <EmptyTitle>Aucune sauvegarde</EmptyTitle>
          <EmptyDescription>
            La première sauvegarde de {databaseName} sera restaurable depuis
            cette liste.
          </EmptyDescription>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Statut</TableHead>
              <TableHead>Origine</TableHead>
              <TableHead>Taille</TableHead>
              <TableHead>Durée</TableHead>
              <TableHead>Prise</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((backup) => (
              <BackupLine
                backup={backup}
                key={backup.id}
                onRestore={onRestore}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function BackupLine({
  backup,
  onRestore,
}: {
  backup: BackupRow;
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
        {relativeTime(backup.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        {/* Seule une sauvegarde complète est restaurable : une demi-sauvegarde
            n'est pas une option qu'on propose. Le serveur le revérifie. */}
        {backup.status === "completed" ? (
          <Button onClick={handleRestore} size="sm" variant="outline">
            Restaurer
          </Button>
        ) : (
          <span
            className="text-muted-foreground text-xs"
            title={backup.errorMessage ?? undefined}
          >
            {backup.errorMessage ? "voir l'erreur" : "—"}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * La confirmation de restauration.
 *
 * Elle demande le nom à la main, et ce n'est pas un ornement : le serveur
 * refuse la requête si le nom ne correspond pas. Le dialogue rend le
 * garde-fou visible, il ne le crée pas.
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
  const [typed, setTyped] = useState("");
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value),
    []
  );
  const handleConfirm = useCallback(() => onConfirm(typed), [onConfirm, typed]);

  return (
    <Dialog onOpenChange={onOpenChange} open={backup !== null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restaurer {databaseName} ?</DialogTitle>
          <DialogDescription>
            Les données actuelles de cette base seront{" "}
            <strong>définitivement remplacées</strong> par celles de la
            sauvegarde
            {backup ? ` du ${relativeTime(backup.createdAt)}` : ""}. Noddle
            prend automatiquement une sauvegarde de sûreté juste avant, pour que
            l'opération reste réversible.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="confirmName">
            Tapez <code className="font-mono">{databaseName}</code> pour
            confirmer
          </Label>
          <Input
            autoComplete="off"
            id="confirmName"
            onChange={handleChange}
            value={typed}
          />
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Annuler</Button>} />
          <Button
            disabled={typed !== databaseName || pending}
            onClick={handleConfirm}
            variant="destructive"
          >
            {pending ? <Spinner /> : null}
            Restaurer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
