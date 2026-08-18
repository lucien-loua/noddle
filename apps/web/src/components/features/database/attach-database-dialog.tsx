import { attachDatabaseSchema } from "@noddle/shared/validation/database";
import { CodeIcon, PlusIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";

import { useAppForm } from "@/components/fields/lib/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import type { ServiceRow } from "@/server/dashboard";
import { attachDatabase } from "@/server/databases";

const attachFormSchema = attachDatabaseSchema.pick({
  envVarKey: true,
  serviceId: true,
});

interface Props {
  databaseId: string;
  defaultKey: string;
  /** Controlled from the outside — a context menu, for example — whose
   *  trigger lives elsewhere. Omitted: the component stays self-contained,
   *  with its own "Attach" button, like on a database's detail card. */
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  services: ServiceRow[];
  /** `false`: does NOT render its own trigger, only the dialog's content.
   *  Goes together with `open`/`onOpenChange` — without them the dialog
   *  could never open. */
  showTrigger?: boolean;
}

export function AttachDatabaseDialog({
  databaseId,
  defaultKey,
  onOpenChange: controlledOnOpenChange,
  open: controlledOpen,
  services,
  showTrigger = true,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;

  const noServices = services.length === 0;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      {showTrigger ? (
        <DialogTrigger render={<Button size="xs" variant="outline" />}>
          <PlusIcon data-icon="inline-start" weight="regular" />
          Attach
        </DialogTrigger>
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach to a service</DialogTitle>
          <DialogDescription>
            The connection string is written as an environment variable of the
            chosen service. It is never shown here.
          </DialogDescription>
        </DialogHeader>

        {noServices ? (
          <Alert variant="destructive">
            <AlertDescription>
              No services to attach to. Connect a repository first.
            </AlertDescription>
          </Alert>
        ) : (
          <AttachBody
            databaseId={databaseId}
            defaultKey={defaultKey}
            open={open}
            services={services}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface AttachFormValues {
  envVarKey: string;
  serviceId: string;
}

function AttachBody({
  databaseId,
  defaultKey,
  open,
  services,
}: {
  databaseId: string;
  defaultKey: string;
  open: boolean;
  services: ServiceRow[];
}) {
  const router = useRouter();
  const [done, setDone] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: (value: AttachFormValues) =>
      attachDatabase({
        data: {
          databaseId,
          envVarKey: value.envVarKey,
          serviceId: value.serviceId,
        },
      }),
    onSuccess: async (result) => {
      setDone(result.key);
      await router.invalidate();
    },
  });

  const form = useAppForm({
    defaultValues: {
      envVarKey: defaultKey,
      // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive, services can be empty
      serviceId: services[0]?.id ?? "",
    } as AttachFormValues,
    onSubmit: ({ value }) => attach.mutateAsync(value),
    validators: { onDynamic: attachFormSchema },
  });

  useEffect(() => {
    if (!open) {
      form.reset();
      setDone(null);
    }
  }, [open, form.reset]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  if (done) {
    return (
      <Alert>
        <AlertDescription>
          Attached: <code>{done}</code> is now in the service environment
          variables, ready for the next deploy.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <DialogForm onSubmit={handleSubmit}>
      <DialogBody>
        <FieldGroup>
          <form.AppField name="serviceId">
            {(f) => (
              <f.FieldCombobox
                emptyText="No application matches."
                items={services}
                // biome-ignore lint/performance/noJsxPropsBind: inline for type inference from items={services}
                itemToId={(service) => service.id}
                // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                itemToStringLabel={(service) => service.name}
                // Project and environment included in the search: two
                // services can share the same name in two environments.
                // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                itemToStringValue={(service) =>
                  `${service.project} / ${service.environment} · ${service.name}`
                }
                label="Application"
                placeholder="Search applications…"
                // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                renderItem={(service) => (
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate">{service.name}</span>
                    <span className="font-normal text-muted-foreground text-xs">
                      {service.project} / {service.environment}
                    </span>
                  </span>
                )}
              />
            )}
          </form.AppField>

          <form.AppField name="envVarKey">
            {(f) => (
              <f.FieldText
                addonStart={<CodeIcon />}
                label="Variable name"
                required
              />
            )}
          </form.AppField>

          {attach.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {errorMessage(attach.error, "could not attach")}
              </AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
      </DialogBody>

      <DialogFooter>
        <Button disabled={attach.isPending} type="submit">
          {attach.isPending ? <Spinner data-icon="inline-start" /> : null}
          Attach
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
