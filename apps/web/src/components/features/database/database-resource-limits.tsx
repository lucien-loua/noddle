import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { z } from "zod";

import { useAppForm } from "@/components/fields/lib/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { setDatabaseResources } from "@/server/databases";

const MIB = 1024 * 1024;
const NANOS_PER_CPU = 1_000_000_000;

const bytesToMib = (bytes: number | null): number | null =>
  bytes === null ? null : Math.round(bytes / MIB);
const mibToBytes = (mib: number | null): number | null =>
  mib === null ? null : Math.round(mib * MIB);
const nanosToCores = (nanos: number | null): number | null =>
  nanos === null ? null : nanos / NANOS_PER_CPU;
const coresToNanos = (cores: number | null): number | null =>
  cores === null ? null : Math.round(cores * NANOS_PER_CPU);

interface ResourceFormValues {
  cpuLimit: number | null;
  cpuReservation: number | null;
  memLimit: number | null;
  memReservation: number | null;
}

const resourceFormSchema = z
  .object({
    cpuLimit: z.number().nullable(),
    cpuReservation: z.number().nullable(),
    memLimit: z.number().nullable(),
    memReservation: z.number().nullable(),
  })
  // The screen was already PROMISING this ("Must not exceed the limit")
  // with nothing to back it up: a reservation cannot exceed its limit, for
  // either of the two resources.
  .refine(
    (v) =>
      v.memLimit === null ||
      v.memReservation === null ||
      v.memReservation <= v.memLimit,
    {
      message: "The reservation cannot exceed the memory limit.",
      path: ["memReservation"],
    }
  )
  .refine(
    (v) =>
      v.cpuLimit === null ||
      v.cpuReservation === null ||
      v.cpuReservation <= v.cpuLimit,
    {
      message: "The reservation cannot exceed the CPU limit.",
      path: ["cpuReservation"],
    }
  );

export function DatabaseResourceLimits({
  canEdit,
  cpuLimitNanos,
  cpuReservationNanos,
  databaseId,
  memoryLimitBytes,
  memoryReservationBytes,
}: {
  /** `database: create` — setting a limit is a configuration change, not an
   *  action on what's running. */
  canEdit: boolean;
  cpuLimitNanos: number | null;
  cpuReservationNanos: number | null;
  databaseId: string;
  memoryLimitBytes: number | null;
  memoryReservationBytes: number | null;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const save = useMutation({
    mutationFn: (value: ResourceFormValues) =>
      setDatabaseResources({
        data: {
          cpuLimitNanos: coresToNanos(value.cpuLimit),
          cpuReservationNanos: coresToNanos(value.cpuReservation),
          databaseId,
          memoryLimitBytes: mibToBytes(value.memLimit),
          memoryReservationBytes: mibToBytes(value.memReservation),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  const defaultValues: ResourceFormValues = {
    cpuLimit: nanosToCores(cpuLimitNanos),
    cpuReservation: nanosToCores(cpuReservationNanos),
    memLimit: bytesToMib(memoryLimitBytes),
    memReservation: bytesToMib(memoryReservationBytes),
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: resourceFormSchema },
  });

  // After a save, the loader re-reads the database: the form must start
  // over from those values. `useAppForm` reapplies its options on every
  // render but does NOT reset the values (otherwise it would erase what
  // was typed), so this is where we resync, on the four CANONICAL values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the canonical props are the TRIGGER, not values read in the body
  useEffect(() => {
    form.reset();
  }, [
    form.reset,
    cpuLimitNanos,
    cpuReservationNanos,
    memoryLimitBytes,
    memoryReservationBytes,
  ]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Resource limits</FrameTitle>
        <FrameDescription>
          Bound this database so a runaway query cannot take the whole machine
          down. Leave a field empty for no limit. Applies on the next deploy.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <FieldGroup className="grid gap-x-6 gap-y-7 sm:grid-cols-2">
          <form.AppField name="memLimit">
            {(f) => (
              <f.FieldNumber
                description="The container is killed if it exceeds this."
                disabled={!canEdit}
                label="Memory limit"
                placeholder="none"
                step={256}
                unit="MiB"
              />
            )}
          </form.AppField>

          <form.AppField name="memReservation">
            {(f) => (
              <f.FieldNumber
                description="Kept free for this database before it is placed."
                disabled={!canEdit}
                label="Memory reservation"
                placeholder="none"
                step={256}
                unit="MiB"
              />
            )}
          </form.AppField>

          <form.AppField name="cpuLimit">
            {(f) => (
              <f.FieldNumber
                description="Fractions are allowed — 0.5 is half a core."
                disabled={!canEdit}
                label="CPU limit"
                placeholder="none"
                step={0.5}
                unit="cores"
              />
            )}
          </form.AppField>

          <form.AppField name="cpuReservation">
            {(f) => (
              <f.FieldNumber
                description="Kept free for this database before it is placed."
                disabled={!canEdit}
                label="CPU reservation"
                placeholder="none"
                step={0.5}
                unit="cores"
              />
            )}
          </form.AppField>
        </FieldGroup>

        {save.isError ? (
          <Alert className="mt-3" variant="destructive">
            <AlertDescription>
              {errorMessage(save.error, "could not save")}
            </AlertDescription>
          </Alert>
        ) : null}
      </FramePanel>

      {canEdit ? (
        <FrameFooter className="flex-row justify-end">
          <Button
            disabled={save.isPending}
            onClick={handleSubmit}
            size="sm"
            variant="outline"
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </FrameFooter>
      ) : null}
    </Frame>
  );
}
