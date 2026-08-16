import { DEFAULT_DATABASE_IMAGE } from "@noddle/database-spec";
import { imageRefSchema } from "@noddle/shared/validation/database";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { z } from "zod";

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
import { setDatabaseConfiguration } from '@/server/databases';
import type { DatabaseRow } from '@/server/databases';

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
