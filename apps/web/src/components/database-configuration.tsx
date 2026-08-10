import { DEFAULT_DATABASE_IMAGE } from "@noddle/shared/database-engines";
import { imageRefSchema } from "@noddle/shared/validation";
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
import { type DatabaseRow, setDatabaseConfiguration } from "@/server/databases";

const configurationFormSchema = z.object({
  image: imageRefSchema,
});

interface ConfigurationFormValues {
  image: string;
}

function ReadOnlyFact({
  description,
  label,
  value,
}: {
  description: string;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 font-medium text-sm leading-none">{label}</p>
      <p className="truncate font-mono text-sm">{value}</p>
      <p className="mt-1.5 text-muted-foreground text-xs">{description}</p>
    </div>
  );
}

export function DatabaseConfiguration({
  canEdit,
  database,
}: {
  /** `database: create` — swapping the image is a configuration change. */
  canEdit: boolean;
  database: DatabaseRow;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const resolvedImage =
    database.image ?? DEFAULT_DATABASE_IMAGE[database.engine];

  const save = useMutation({
    mutationFn: (value: ConfigurationFormValues) =>
      setDatabaseConfiguration({
        data: {
          databaseId: database.id,
          image: value.image,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  const defaultValues: ConfigurationFormValues = {
    image: resolvedImage,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: configurationFormSchema },
  });

  // After a save, the loader re-reads the database: resync the form from the
  // canonical image so a successful write doesn't leave a dirty field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: image is the TRIGGER
  useEffect(() => {
    form.reset();
  }, [form.reset, resolvedImage]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Configuration</FrameTitle>
        <FrameDescription>
          Engine image applied on the next provision. Replicas stay at one and
          the volume name is fixed — both are tied to the named volume on this
          node.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <FieldGroup className="grid gap-x-6 gap-y-7 sm:grid-cols-3">
          <form.AppField name="image">
            {(f) => (
              <f.FieldText
                description="A major version bump can crash-loop or ignore the existing data directory."
                disabled={!canEdit}
                label="Docker image"
                placeholder={DEFAULT_DATABASE_IMAGE[database.engine]}
                required
              />
            )}
          </form.AppField>

          <ReadOnlyFact
            description="Fixed — a named volume cannot be shared across replicas."
            label="Replicas"
            value="1"
          />

          <ReadOnlyFact
            description="Written at creation and never renamed."
            label="Volume"
            value={database.swarmName}
          />
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
