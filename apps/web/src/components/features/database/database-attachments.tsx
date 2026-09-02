"use client";

import type { DatabaseEngine } from "@noddle/database-spec";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import {
  AttachDatabaseDialog,
  DEFAULT_ENV_VAR_KEY,
} from "@/components/features/database/attach-database-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import type { ServiceRow } from "@/server/dashboard";
import { detachDatabase } from "@/server/dependencies";

export function DatabaseAttachments({
  canAttach,
  databaseId,
  engine,
  services,
}: {
  canAttach: boolean;
  databaseId: string;
  engine: DatabaseEngine;
  services: ServiceRow[];
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const dependents = useQuery(queries.databaseDependents(databaseId));

  const detach = useMutation({
    mutationFn: (serviceId: string) =>
      detachDatabase({ data: { databaseId, serviceId } }),
    onError: (e: Error) => setError(errorMessage(e, "could not detach")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: ["database-dependents", databaseId],
      });
    },
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["database-dependents", databaseId],
    });
  }, [databaseId, queryClient]);

  const rows = dependents.data ?? [];

  return (
    <Frame className="mb-3" stacked variant="ghost">
      <FrameHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-(--frame-panel-header-gap)">
          <FrameTitle>Attached services</FrameTitle>
          <FrameDescription>
            Attaching writes the connection string into the environment of a
            service. Detaching removes both the link and that variable.
          </FrameDescription>
        </div>
        {canAttach ? (
          <AttachDatabaseDialog
            databaseId={databaseId}
            defaultKey={DEFAULT_ENV_VAR_KEY[engine]}
            onAttached={refresh}
            services={services}
          />
        ) : null}
      </FrameHeader>
      {dependents.isPending ? (
        <FramePanel>
          <Spinner />
        </FramePanel>
      ) : null}
      {!dependents.isPending && rows.length === 0 ? (
        <FramePanel>
          <p className="text-muted-foreground text-sm">
            No service uses this database yet.
          </p>
        </FramePanel>
      ) : null}
      {rows.map((row) => (
        <DependentRow
          canDetach={canAttach}
          detaching={detach.isPending && detach.variables === row.serviceId}
          key={row.serviceId}
          onDetach={detach.mutate}
          row={row}
        />
      ))}
      {error ? (
        <FramePanel>
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </FramePanel>
      ) : null}
    </Frame>
  );
}

function DependentRow({
  canDetach,
  detaching,
  onDetach,
  row,
}: {
  canDetach: boolean;
  detaching: boolean;
  onDetach: (serviceId: string) => void;
  row: { envVarKey: string | null; serviceId: string; serviceName: string };
}) {
  const handleDetach = useCallback(
    () => onDetach(row.serviceId),
    [onDetach, row.serviceId]
  );

  return (
    <FramePanel>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-sm">{row.serviceName}</h2>
          <p className="truncate font-mono text-muted-foreground text-xs">
            {row.envVarKey ?? "variable removed"}
          </p>
        </div>
        {canDetach ? (
          <Button
            disabled={detaching}
            onClick={handleDetach}
            size="xs"
            variant="outline"
          >
            {detaching ? <Spinner data-icon="inline-start" /> : null}
            Detach
          </Button>
        ) : null}
      </div>
    </FramePanel>
  );
}
