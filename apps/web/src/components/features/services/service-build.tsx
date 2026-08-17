import { serviceBuildSchema } from "@noddle/shared/validation/service";
import type { ServiceBuildInput } from "@noddle/shared/validation/service";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { useAppForm } from "@/components/fields/lib/form";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
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

const BUILD_OPTIONS = [
  {
    description: "Detects the language and generates a Dockerfile.",
    label: "Railpack",
    value: "railpack",
  },
  {
    description: "Uses the Dockerfile at the repository root.",
    label: "Dockerfile",
    value: "dockerfile",
  },
] as const;

function selectBuildMethod(state: { values: { buildMethod: string } }) {
  return state.values.buildMethod;
}

function buildMethodValue(
  method: ServiceRow["buildMethod"]
): ServiceBuildInput["buildMethod"] {
  return method === "dockerfile" ? "dockerfile" : "railpack";
}

export function ServiceBuild({
  canEdit,
  service,
}: {
  canEdit: boolean;
  service: ServiceRow;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const save = useMutation({
    mutationFn: (value: ServiceBuildInput) =>
      updateServiceSettings({
        data: {
          buildMethod: value.buildMethod,
          publishDirectory: value.publishDirectory,
          serviceId: service.id,
        },
      }),
    onSuccess: async () => {
      await cache.service(queryClient, service.id);
      await router.invalidate();
    },
  });

  const defaultValues: ServiceBuildInput = {
    buildMethod: buildMethodValue(service.buildMethod),
    publishDirectory: service.publishDirectory ?? "",
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: serviceBuildSchema },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: build fields are the TRIGGER
  useEffect(() => {
    form.reset();
  }, [form.reset, service.buildMethod, service.publishDirectory]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Build type</FrameTitle>
        <FrameDescription>
          How the next Deploy turns the repository into an image.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Method</FieldLegend>
            <form.AppField name="buildMethod">
              {(f) => (
                <f.FieldRadio
                  disabled={!canEdit}
                  options={[...BUILD_OPTIONS]}
                />
              )}
            </form.AppField>
          </FieldSet>

          <form.Subscribe selector={selectBuildMethod}>
            {(buildMethod) =>
              buildMethod === "railpack" ? (
                <form.AppField name="publishDirectory">
                  {(f) => (
                    <f.FieldText
                      description="Relative path to the build output (for example dist or build). Railpack serves it as a static site on the next Deploy. Set port to 80 on Domains when using this."
                      disabled={!canEdit}
                      label="Publish directory"
                      placeholder="dist"
                    />
                  )}
                </form.AppField>
              ) : null
            }
          </form.Subscribe>
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
