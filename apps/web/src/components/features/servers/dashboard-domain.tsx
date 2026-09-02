import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect } from "react";
import { z } from "zod";

import { useAppForm } from "@/components/fields/lib/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldTitle } from "@/components/ui/field";
import {
  FrameDescription,
  FrameFooter,
  FrameForm,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import { saveDashboardDomain } from "@/server/control-plane";

const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

const formSchema = z.object({
  acmeEmail: z.string(),
  domain: z.string(),
  httpsEnabled: z.boolean(),
});

interface FormValues {
  acmeEmail: string;
  domain: string;
  httpsEnabled: boolean;
}

function Feedback({
  applying,
  lastError,
  saveError,
}: {
  applying: boolean;
  lastError: string | null;
  saveError: Error | null;
}) {
  if (applying) {
    return (
      <p className="mt-3 text-muted-foreground text-sm">
        Applying. The dashboard restarts behind the new address — this page may
        drop for a few seconds.
      </p>
    );
  }
  if (saveError) {
    return (
      <p className="mt-3 text-destructive text-sm" role="alert">
        {errorMessage(saveError, "could not save")}
      </p>
    );
  }
  if (lastError) {
    return (
      <Alert className="mt-3" variant="destructive">
        <AlertDescription>{lastError}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

interface Access {
  applying: boolean;
  disabled: boolean;
  loaded: boolean;
  managed: boolean;
}

function resolveAccess(
  settings: { managesItsHost: boolean; status: string } | undefined,
  canEdit: boolean
): Access {
  const loaded = settings !== undefined;
  const managed = settings?.managesItsHost ?? true;
  const applying = settings?.status === "applying";
  const disabled = !(loaded && canEdit && managed) || applying;
  return { applying, disabled, loaded, managed };
}

export function DashboardDomain({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const settings = useQuery(queries.controlPlaneSettings());

  const save = useMutation({
    mutationFn: (value: FormValues) =>
      saveDashboardDomain({
        data: {
          acmeEmail: value.acmeEmail.trim() || null,
          domain: value.domain.trim() || null,
          httpsEnabled: value.httpsEnabled,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  const defaultValues: FormValues = {
    acmeEmail: settings.data?.acmeEmail ?? "",
    domain: settings.data?.domain ?? "",
    httpsEnabled: settings.data?.httpsEnabled ?? false,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: formSchema },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, settings.data]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  const { applying, disabled, loaded, managed } = resolveAccess(
    settings.data,
    canEdit
  );

  return (
    <FrameForm onSubmit={handleSubmit} variant="ghost">
      <FrameHeader>
        <FrameTitle>Dashboard domain</FrameTitle>
        <FrameDescription>
          Where this dashboard answers. Point an A record at this machine first
          — the certificate is requested once the record resolves.
        </FrameDescription>
      </FrameHeader>

      <FramePanel>
        {loaded && !managed ? (
          <Alert className="mb-3">
            <AlertDescription>
              This Noddle was not installed by <code>install.sh</code>, so it
              does not manage the machine it runs on. Set the domain in your own
              reverse proxy instead.
            </AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup>
          <form.AppField
            name="domain"
            validators={{
              onChange: ({ value }: { value: string }) =>
                value.trim() && !HOSTNAME.test(value.trim())
                  ? "not a hostname"
                  : undefined,
            }}
          >
            {(f) => (
              <f.FieldText
                disabled={disabled}
                label="Domain"
                placeholder="noddle.example.com"
              />
            )}
          </form.AppField>

          <form.AppField name="acmeEmail">
            {(f) => (
              <f.FieldText
                description="Let's Encrypt sends expiry warnings here."
                disabled={disabled}
                label="Contact address"
                placeholder="you@example.com"
              />
            )}
          </form.AppField>

          <form.AppField name="httpsEnabled">
            {(f) => (
              <Field orientation="horizontal">
                <FieldTitle>
                  HTTPS
                  <span className="block font-normal text-muted-foreground text-xs">
                    Request a certificate and redirect plain HTTP to it.
                  </span>
                </FieldTitle>
                <Switch
                  checked={f.state.value as boolean}
                  disabled={disabled}
                  onCheckedChange={(next) => f.handleChange(next)}
                />
              </Field>
            )}
          </form.AppField>
        </FieldGroup>

        <Feedback
          applying={applying}
          lastError={settings.data?.lastError ?? null}
          saveError={save.isError ? save.error : null}
        />
      </FramePanel>

      {loaded && canEdit && managed ? (
        <FrameFooter className="flex-row justify-end">
          <Button
            disabled={save.isPending || applying}
            size="sm"
            type="submit"
            variant="outline"
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </FrameFooter>
      ) : null}
    </FrameForm>
  );
}
