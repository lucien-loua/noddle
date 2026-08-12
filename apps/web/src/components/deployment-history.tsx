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
  /** `service:rollback` — a courtesy, not the permission itself: the server
   *  re-checks it anyway. Without it, the column stays empty rather than
   *  offering a button the mutation would refuse. */
  canRollback: boolean;
  currentDeploymentId: string | null;
  deployments: DeploymentSummary[];
  onRollback: (deploymentId: string) => void;
  onSelect: (deploymentId: string) => void;
  pending: boolean;
  selectedId: string | null;
}

/**
 * The action cell is a component, not a closure inline in the render:
 * it's the only way to hold a stable handler there, since it depends on
 * the row.
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
      // Without this, the click bubbles up to the row and ALSO changes the
      // displayed deployment — you'd redeploy one version while looking at
      // another.
      event.stopPropagation();
      onRollback(deployment.id);
    },
    [deployment.id, onRollback]
  );

  // Only a deployment that PRODUCED an image can be redeployed. A build
  // that failed before `docker build` left nothing behind, and offering
  // the button would lie about what Noddle can do.
  if (!deployment.imageTag) {
    return <span className="text-muted-foreground">—</span>;
  }
  // The image existed, then it was removed — by the registry's retention
  // (`registry-sweep`) if it lived there, by the node's daily purge
  // (`prune`) if it was local. Same rule in both cases: don't offer an
  // action already known to fail. The word says WHY, without which a dash
  // here and a dash above would mean two different things with nothing to
  // tell them apart.
  if (deployment.imagePurged) {
    return <span className="text-muted-foreground">expired</span>;
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
