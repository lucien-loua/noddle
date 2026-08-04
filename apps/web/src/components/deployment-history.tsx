// L'historique, et le retour arrière.
//
// Ce tableau n'est pas une page d'archives : c'est le mécanisme du rollback.
// Noddle conserve le tag d'image de CHAQUE déploiement, donc chaque ligne qui
// en porte un est une cible atteignable. Swarm, lui, ne garde qu'une seule
// spec antérieure — c'est exactement la capacité que cet écran expose.
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  type Row,
  useReactTable,
} from "@tanstack/react-table";
import type { MouseEvent } from "react";
import { useCallback, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  badgeVariant,
  deploymentLabel,
  duration,
  relativeTime,
  shortSha,
  triggerLabel,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeploymentSummary } from "@/server/dashboard";

interface Props {
  /** `service:rollback` — politesse, pas la permission : le serveur la
   *  revérifie de toute façon. Sans elle, la colonne reste vide plutôt que de
   *  proposer un bouton que la mutation refuserait. */
  canRollback: boolean;
  currentDeploymentId: string | null;
  deployments: DeploymentSummary[];
  onRollback: (deploymentId: string) => void;
  onSelect: (deploymentId: string) => void;
  pending: boolean;
  selectedId: string | null;
}

/**
 * La cellule d'action est un composant, pas une fermeture dans le rendu :
 * c'est le seul moyen d'y tenir un gestionnaire stable, puisqu'il dépend de la
 * ligne.
 */
function RollbackCell({
  canRollback,
  currentDeploymentId,
  deployment,
  onRollback,
  pending,
}: {
  canRollback: boolean;
  currentDeploymentId: string | null;
  deployment: DeploymentSummary;
  onRollback: (deploymentId: string) => void;
  pending: boolean;
}) {
  const handleClick = useCallback(
    (event: MouseEvent) => {
      // Sans ça, le clic remonte à la ligne et change AUSSI le déploiement
      // affiché — on rejouerait une version tout en regardant une autre.
      event.stopPropagation();
      onRollback(deployment.id);
    },
    [deployment.id, onRollback]
  );

  // Seul un déploiement ayant PRODUIT une image est rejouable. Un build qui a
  // échoué avant `docker build` n'a rien laissé derrière lui, et proposer le
  // bouton mentirait sur ce que Noddle peut faire.
  if (!deployment.imageTag) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (deployment.id === currentDeploymentId) {
    return <span className="text-muted-foreground">live</span>;
  }
  if (!canRollback) {
    return null;
  }
  return (
    <Button
      disabled={pending}
      onClick={handleClick}
      size="xs"
      variant="outline"
    >
      Redeploy
    </Button>
  );
}

function HistoryRow({
  onSelect,
  row,
  selected,
}: {
  onSelect: (deploymentId: string) => void;
  row: Row<DeploymentSummary>;
  selected: boolean;
}) {
  const handleClick = useCallback(
    () => onSelect(row.original.id),
    [onSelect, row.original.id]
  );

  return (
    <TableRow
      className={cn("cursor-pointer", selected && "bg-muted")}
      onClick={handleClick}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
}

const columnHelper = createColumnHelper<DeploymentSummary>();

export function DeploymentHistory(props: Props) {
  const {
    canRollback,
    currentDeploymentId,
    deployments,
    onRollback,
    onSelect,
    pending,
    selectedId,
  } = props;

  const columns = useMemo(
    () => [
      columnHelper.accessor("status", {
        cell: (info) => {
          const { label, tone } = deploymentLabel(info.getValue());
          return <Badge variant={badgeVariant(tone)}>{label}</Badge>;
        },
        header: "Status",
      }),
      columnHelper.accessor("commitSha", {
        cell: (info) => (
          <span className="font-mono text-xs">{shortSha(info.getValue())}</span>
        ),
        header: "Commit",
      }),
      columnHelper.accessor("trigger", {
        cell: (info) => (
          <span className="text-muted-foreground">
            {triggerLabel(info.getValue())}
          </span>
        ),
        header: "Trigger",
      }),
      columnHelper.accessor("createdAt", {
        cell: (info) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {relativeTime(info.getValue())}
          </span>
        ),
        header: "When",
      }),
      columnHelper.display({
        cell: (info) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {duration(
              info.row.original.createdAt,
              info.row.original.finishedAt
            )}
          </span>
        ),
        header: "Duration",
        id: "duration",
      }),
      columnHelper.display({
        cell: (info) => (
          <RollbackCell
            canRollback={canRollback}
            currentDeploymentId={currentDeploymentId}
            deployment={info.row.original}
            onRollback={onRollback}
            pending={pending}
          />
        ),
        header: "",
        id: "actions",
      }),
    ],
    [canRollback, currentDeploymentId, onRollback, pending]
  );

  const table = useReactTable({
    columns,
    data: deployments,
    getCoreRowModel: getCoreRowModel(),
  });

  if (deployments.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No deployments for this service yet.
      </p>
    );
  }

  return (
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
          <HistoryRow
            key={row.id}
            onSelect={onSelect}
            row={row}
            selected={row.original.id === selectedId}
          />
        ))}
      </TableBody>
    </Table>
  );
}
