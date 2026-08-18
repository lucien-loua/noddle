/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { generateTestDomain } from "@noddle/shared/generate-domain";
import { serviceDomainsSchema } from "@noddle/shared/validation/service";
import type { ServiceDomainsInput } from "@noddle/shared/validation/service";
import { DiceFiveIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { useAppForm } from "@/components/fields/lib/form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { InputGroupButton } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import type { ServiceDomainRow, ServiceRow } from "@/server/dashboard";
import {
  createServiceDomain,
  updateServiceDomain,
} from "@/server/service-domains";

const CERTIFICATE_OPTIONS = [
  {
    description: "Automatic certificate via Let's Encrypt",
    label: "Let's Encrypt",
    value: "letsencrypt",
  },
  {
    description:
      "TLS without automatic provisioning: bring your own certificate in Traefik",
    label: "None",
    value: "none",
  },
] as const;

function selectHttps(state: { values: ServiceDomainsInput }) {
  return state.values.https;
}

export function ServiceDomainDialog({
  domain,
  onOpenChange,
  open,
  service,
}: {
  domain: ServiceDomainRow | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  service: ServiceRow;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const isEdit = domain !== null;

  const save = useMutation({
    mutationFn: async (value: ServiceDomainsInput) => {
      const payload = {
        certificateType: value.certificateType,
        host: value.host,
        https: value.https,
        internalPath: value.internalPath,
        path: value.path,
        port: value.port,
        stripPath: value.stripPath,
      };
      if (isEdit && domain) {
        await updateServiceDomain({
          data: { ...payload, domainId: domain.id },
        });
        return;
      }
      await createServiceDomain({
        data: { ...payload, serviceId: service.id },
      });
    },
    onSuccess: async () => {
      await cache.service(queryClient, service.id);
      await router.invalidate();
      onOpenChange(false);
    },
  });

  const defaultValues: ServiceDomainsInput = {
    certificateType: domain ? domain.certificateType : "none",
    host: domain ? domain.host : "",
    https: domain ? domain.https : false,
    internalPath: domain?.internalPath ?? "",
    path: domain && domain.path !== "/" ? domain.path : "",
    port: service.port,
    stripPath: domain ? domain.stripPath : false,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: serviceDomainsSchema },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: domain fields are the TRIGGER
  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [
    domain?.certificateType,
    domain?.host,
    domain?.https,
    domain?.id,
    domain?.internalPath,
    domain?.path,
    domain?.stripPath,
    form.reset,
    open,
    service.port,
  ]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  const handleGenerateHost = useCallback(() => {
    form.setFieldValue(
      "host",
      generateTestDomain({
        appName: service.name,
        serverHost: service.serverHost,
      })
    );
  }, [form, service.name, service.serverHost]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Domain</DialogTitle>
          <DialogDescription>
            Public hostname, path routing, TLS, and the container port Traefik
            forwards to.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <FieldGroup>
            <form.AppField name="host">
              {(f) => (
                <f.FieldText
                  addonEnd={
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <InputGroupButton
                            aria-label="Generate test domain"
                            onClick={handleGenerateHost}
                            size="icon-xs"
                          />
                        }
                      >
                        <DiceFiveIcon />
                      </TooltipTrigger>
                      <TooltipContent>
                        Generate a free sslip.io domain for testing. No DNS
                        setup required.
                      </TooltipContent>
                    </Tooltip>
                  }
                  description="Your public hostname. Use the dice to generate a test domain that resolves to this server's IP."
                  label="Host"
                  placeholder="app.example.com"
                  required
                />
              )}
            </form.AppField>
            <form.AppField name="path">
              {(f) => (
                <f.FieldText
                  description="Public URL prefix. Leave empty for the entire host."
                  label="Path"
                  placeholder="/"
                />
              )}
            </form.AppField>
            <form.AppField name="internalPath">
              {(f) => (
                <f.FieldText
                  description="Prefix forwarded to the container before your app sees the request."
                  label="Internal path"
                  placeholder="/"
                />
              )}
            </form.AppField>
            <form.AppField name="stripPath">
              {(f) => (
                <Field orientation="horizontal">
                  <div className="flex flex-1 flex-col gap-1">
                    <FieldLabel className="font-medium">Strip path</FieldLabel>
                    <FieldDescription>
                      Remove the public path prefix before forwarding.
                    </FieldDescription>
                  </div>
                  <Switch
                    checked={f.state.value}
                    onCheckedChange={f.handleChange}
                  />
                </Field>
              )}
            </form.AppField>
            <form.AppField name="port">
              {(f) => (
                <f.FieldNumber
                  description="The port your process listens on inside the container (for example 3000 for Node.js or 80 for a static site). Noddle also injects it as PORT."
                  label="Container port"
                  min={1}
                  required
                  step={1}
                />
              )}
            </form.AppField>

            <form.AppField name="https">
              {(f) => (
                <Field orientation="horizontal">
                  <div className="flex flex-1 flex-col gap-1">
                    <FieldLabel className="font-medium">HTTPS</FieldLabel>
                    <FieldDescription>
                      Serve this hostname over TLS. Redeploy to apply routing
                      changes.
                    </FieldDescription>
                  </div>
                  <Switch
                    checked={f.state.value}
                    onCheckedChange={(checked) => {
                      f.handleChange(checked);
                      if (checked) {
                        form.setFieldValue("certificateType", "letsencrypt");
                      } else {
                        form.setFieldValue("certificateType", "none");
                      }
                    }}
                  />
                </Field>
              )}
            </form.AppField>

            <form.Subscribe selector={selectHttps}>
              {(https) =>
                https ? (
                  <form.AppField name="certificateType">
                    {(f) => (
                      <f.FieldSelect
                        label="Certificate"
                        options={[...CERTIFICATE_OPTIONS]}
                        required
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
        </DialogBody>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button disabled={save.isPending} onClick={handleSubmit}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            {isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
