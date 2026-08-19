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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import type { ServiceRow } from "@/server/dashboard";
import { detachDatabase } from "@/server/dependencies";

/**
 * Who consumes this database, and the two actions that change that list.
 *
 * Detaching is a statement of its own: it drops the declared dependency AND
 * the variable attaching wrote. Deleting that variable from the service's
 * table is NOT the same thing — the link survives it (ADR-0021), which is
 * why this list can show a service whose key is gone.
 */
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
    <Frame className="mb-3" variant="ghost">
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
      <FramePanel>
        {dependents.isPending ? <Spinner /> : null}
        {!dependents.isPending && rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No service uses this database yet.
          </p>
        ) : null}
        {rows.length > 0 ? (
          <ItemGroup className="gap-2">
            {rows.map((row) => (
              <DependentRow
                canDetach={canAttach}
                detaching={
                  detach.isPending && detach.variables === row.serviceId
                }
                key={row.serviceId}
                onDetach={detach.mutate}
                row={row}
              />
            ))}
          </ItemGroup>
        ) : null}
        {error ? (
          <Alert className="mt-3" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </FramePanel>
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
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>{row.serviceName}</ItemTitle>
        <ItemDescription>
          {row.envVarKey ? (
            <code>{row.envVarKey}</code>
          ) : (
            // The variable was deleted by hand; the declared link outlived it.
            "variable removed"
          )}
        </ItemDescription>
      </ItemContent>
      {canDetach ? (
        <ItemActions>
          <Button
            disabled={detaching}
            onClick={handleDetach}
            size="xs"
            variant="outline"
          >
            {detaching ? <Spinner data-icon="inline-start" /> : null}
            Detach
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
}
