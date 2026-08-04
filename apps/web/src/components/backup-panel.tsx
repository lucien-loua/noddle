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
  errorMessage,
  relativeTime,
} from "@/lib/format";
import {
  type BackupRow,
  getBackups,
  saveBackupSchedule,
  triggerBackup,
} from "@/server/backups";

/**
 * Tant qu'une sauvegarde tourne, on resonde. Elle dure des secondes à des
 * minutes selon la base : sans ça la ligne resterait « En cours » jusqu'à ce
 * que l'utilisateur recharge, et il conclurait que c'est bloqué.
 */
const POLL_MS = 3000;

const SCHEDULES: { label: string; value: Schedule }[] = [
  { label: "Jamais", value: "off" },
  { label: "Chaque jour", value: "daily" },
  { label: "Chaque semaine", value: "weekly" },
];

type Schedule = "daily" | "off" | "weekly";

/**
 * Le rythme automatique, en trois boutons.
 *
 * Ni cron ni sélecteur d'heure : « tous les jours » suffit à la question que
 * l'utilisateur se pose, et l'heure exacte n'est pas un réglage tant que
 * personne ne l'a demandée. La rétention est à côté parce que les deux se
 * décident ensemble — activer une planification sans borner ce qu'on garde,
 * c'est signer pour une facture de stockage qui monte toute seule.
 */
function ScheduleControl({
  databaseId,
  retention,
  schedule,
}: {
  databaseId: string;
  retention: number;
  schedule: Schedule;
}) {
  const [value, setValue] = useState<Schedule>(schedule);
  const [keep, setKeep] = useState(String(retention));

  const save = useMutation({
    mutationFn: (next: { retention: number; schedule: Schedule }) =>
      saveBackupSchedule({
        data: {
          databaseId,
          retention: next.retention,
          schedule: next.schedule,
        },
      }),
    // La bascule est optimiste pour que le clic réponde tout de suite, donc
    // elle DOIT être annulée quand le serveur refuse. Sans ça, un
    // enregistrement rejeté — une planification sans destination, par exemple —
    // laissait « Chaque jour » sélectionné alors que la base restait sur son
    // ancien rythme : l'écran affirmait une protection qui n'existait pas.
    // Constaté dans un vrai navigateur.
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
      save.mutate({ retention: Number(keep) || 1, schedule: next });
    },
    [keep, save]
  );

  const handleKeep = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setKeep(e.target.value),
    []
  );
  const handleKeepBlur = useCallback(() => {
    const n = Number(keep);
    if (Number.isInteger(n) && n >= 1 && n <= 100) {
      save.mutate({ retention: n, schedule: value });
    } else {
      setKeep(String(retention));
    }
  }, [keep, retention, save, value]);

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-3">
      <span className="text-muted-foreground text-xs">Automatique</span>
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
          en gardant
          <Input
            className="h-7 w-16 text-xs"
            inputMode="numeric"
            onBlur={handleKeepBlur}
            onChange={handleKeep}
            value={keep}
          />
        </span>
      )}

      {save.isError ? (
        <span className="text-destructive text-xs">
          {errorMessage(save.error, "échec")}
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
  databaseId: string;
  databaseName: string;
  onRestore: (backup: BackupRow) => void;
  retention: number;
  schedule: Schedule;
}

export function BackupPanel({
  databaseId,
  databaseName,
  onRestore,
  retention,
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
            {errorMessage(run.error, "sauvegarde impossible")}
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

      <ScheduleControl
        databaseId={databaseId}
        retention={retention}
        schedule={schedule}
      />
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
            {backup ? ` prise ${relativeTime(backup.createdAt)}` : ""}. Noddle
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
