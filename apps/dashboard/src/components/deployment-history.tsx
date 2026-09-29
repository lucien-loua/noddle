import {
  createColumnHelper,
  FlexRender,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { Row } from "@tanstack/react-table";
import type { MouseEvent } from "react";
import { useCallback, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  deploymentLabel,
  duration,
  relativeTime,
  shortSha,
  triggerLabel,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeploymentSummary } from "@/server/dashboard";

interface Props {
  canRollback: boolean;
  currentDeploymentId: string | null;
  deployments: DeploymentSummary[];
  onRollback: (deploymentId: string) => void;
  onSelect: (deploymentId: string) => void;
  pending: boolean;
  selectedId: string | null;
}

const RollbackCell = ({
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
}) => {
  const handleClick = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      onRollback(deployment.id);
    },
    [deployment.id, onRollback]
  );

  if (!deployment.imageTag) {
    return <span className="text-muted-foreground">—</span>;
  }
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
};

const HistoryRow = ({
  onSelect,
  row,
  selected,
}: {
  onSelect: (deploymentId: string) => void;
  row: Row<typeof features, DeploymentSummary>;
  selected: boolean;
}) => {
  const handleClick = useCallback(
    () => onSelect(row.original.id),
    [onSelect, row.original.id]
  );

  return (
    <TableRow
      className={cn("cursor-pointer", selected && "bg-muted")}
      onClick={handleClick}
    >
      {row.getAllCells().map((cell) => (
        <TableCell key={cell.id}>
          <FlexRender cell={cell} />
        </TableCell>
      ))}
    </TableRow>
  );
};

const features = tableFeatures({});

const columnHelper = createColumnHelper<typeof features, DeploymentSummary>();

export const DeploymentHistory = (props: Props) => {
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
    () =>
      columnHelper.columns([
        columnHelper.accessor("status", {
          cell: (info) => {
            const { label, tone } = deploymentLabel(info.getValue());
            return (
              <Status tone={tone}>
                <StatusIndicator />
                <StatusLabel>{label}</StatusLabel>
              </Status>
            );
          },
          header: "Status",
        }),
        columnHelper.accessor("commitSha", {
          cell: (info) => (
            <span className="font-mono text-xs">
              {shortSha(info.getValue())}
            </span>
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
            <span className="text-muted-foreground whitespace-nowrap">
              {relativeTime(info.getValue())}
            </span>
          ),
          header: "When",
        }),
        columnHelper.display({
          cell: (info) => (
            <span className="text-muted-foreground whitespace-nowrap">
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
      ]),
    [canRollback, currentDeploymentId, onRollback, pending]
  );

  const table = useTable({ columns, data: deployments, features });

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
                <FlexRender header={header} />
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
};
