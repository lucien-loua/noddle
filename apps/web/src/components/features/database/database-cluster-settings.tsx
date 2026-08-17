import { GearSixIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { DatabaseSwarmSettingsDialog } from "@/components/features/database/database-swarm-settings-dialog";
import { useAppForm } from "@/components/fields/lib/form";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { setDatabaseReplicas } from "@/server/databases";

interface ReplicasFormValues {
  replicas: number | null;
}

export function DatabaseClusterSettings({
  canEdit,
  databaseId,
  replicas,
  swarmSettings,
}: {
  canEdit: boolean;
  databaseId: string;
  replicas: number;
  swarmSettings: Parameters<typeof DatabaseSwarmSettingsDialog>[0]["swarmSettings"];
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [swarmOpen, setSwarmOpen] = useState(false);
  const openSwarm = useCallback(() => setSwarmOpen(true), []);

  const save = useMutation({
    mutationFn: (value: ReplicasFormValues) => {
      if (value.replicas === null) {
        throw new Error("replicas is required");
      }
      return setDatabaseReplicas({
        data: { databaseId, replicas: value.replicas },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  const form = useAppForm({
    defaultValues: { replicas } satisfies ReplicasFormValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: {
      onDynamic: z.object({
        replicas: z.number().int().min(1).max(50),
      }),
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: replicas is the TRIGGER
  useEffect(() => {
    form.reset();
  }, [form.reset, replicas]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  return (
    <>
      <Frame variant="ghost">
        <FrameHeader className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <FrameTitle>Cluster Settings</FrameTitle>
            <FrameDescription>
              Applied on the next provision. Keep replicas at 1 unless the data volume is shared —
              otherwise you risk corruption or an empty volume.
            </FrameDescription>
          </div>
          {canEdit ? (
            <Button onClick={openSwarm} size="sm" type="button" variant="outline">
              <GearSixIcon data-icon="inline-start" />
              Swarm Settings
            </Button>
          ) : null}
        </FrameHeader>
        <FramePanel>
          <FieldGroup>
            <form.AppField name="replicas">
              {(f) => (
                <f.FieldNumber disabled={!canEdit} label="Replicas" min={1} required step={1} />
              )}
            </form.AppField>
          </FieldGroup>

          {save.isError ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {errorMessage(save.error, "could not save")}
            </p>
          ) : null}
        </FramePanel>

        {canEdit ? (
          <FrameFooter className="flex-row justify-end">
            <Button disabled={save.isPending} onClick={handleSubmit} size="sm" variant="outline">
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </FrameFooter>
        ) : null}
      </Frame>

      <DatabaseSwarmSettingsDialog
        databaseId={databaseId}
        onOpenChange={setSwarmOpen}
        open={swarmOpen}
        swarmSettings={swarmSettings}
      />
    </>
  );
}
