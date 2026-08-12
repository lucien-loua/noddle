import {
  type ServiceProviderInput,
  serviceProviderSchema,
} from "@noddle/shared/validation/service";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
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
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import type { ServiceRow } from "@/server/dashboard";
import { updateServiceSettings } from "@/server/services";

export function ServiceProvider({
  canEdit,
  service,
}: {
  canEdit: boolean;
  service: ServiceRow;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const save = useMutation({
    mutationFn: (value: ServiceProviderInput) =>
      updateServiceSettings({
        data: {
          gitBranch: value.gitBranch,
          gitRepoUrl: value.gitRepoUrl,
          serviceId: service.id,
        },
      }),
    onSuccess: async () => {
      await cache.service(queryClient, service.id);
      await router.invalidate();
    },
  });

  const defaultValues: ServiceProviderInput = {
    gitBranch: service.gitBranch ?? "main",
    gitRepoUrl: service.gitRepoUrl ?? "",
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: serviceProviderSchema },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: repo fields are the TRIGGER
  useEffect(() => {
    form.reset();
  }, [form.reset, service.gitBranch, service.gitRepoUrl]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Provider</FrameTitle>
        <FrameDescription>
          Git source used on the next Deploy. Saving does not start a build.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <FieldGroup>
          <form.AppField name="gitRepoUrl">
            {(f) => (
              <f.FieldText
                disabled={!canEdit}
                label="Repository URL"
                placeholder="https://github.com/org/repo.git"
              />
            )}
          </form.AppField>
          <form.AppField name="gitBranch">
            {(f) => (
              <f.FieldText
                disabled={!canEdit}
                label="Branch"
                placeholder="main"
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
