import { DEFAULT_DATABASE_IMAGE } from "@noddle/shared/database-spec";
import { imageRefSchema } from "@noddle/shared/validation/database";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect } from "react";
import { z } from "zod";

import { useAppForm } from "@/components/fields/lib/form";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import {
  FrameDescription,
  FrameFooter,
  FrameForm,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { setDatabaseConfiguration } from "@/server/databases";
import type { DatabaseRow } from "@/server/databases";

const configurationFormSchema = z.object({
  image: imageRefSchema,
});

interface ConfigurationFormValues {
  image: string;
}

export function DatabaseConfiguration({
  canEdit,
  database,
}: {
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

  useEffect(() => {
    form.reset();
  }, [form.reset, resolvedImage]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <FrameForm onSubmit={handleSubmit} variant="ghost">
      <FrameHeader>
        <FrameTitle>Configuration</FrameTitle>
        <FrameDescription>
          Engine image applied on the next provision. A major version bump can
          crash-loop or ignore the existing data directory.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <FieldGroup>
          <form.AppField name="image">
            {(f) => (
              <f.FieldText
                disabled={!canEdit}
                label="Docker image"
                placeholder={DEFAULT_DATABASE_IMAGE[database.engine]}
                required
              />
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
          <Button
            disabled={save.isPending}
            size="sm"
            variant="outline"
            type="submit"
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </FrameFooter>
      ) : null}
    </FrameForm>
  );
}
