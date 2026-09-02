import { connectRepoSchema } from "@noddle/shared/validation/service";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect } from "react";

import { NoServersEmpty } from "@/components/features/servers/no-servers-empty";
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
} from "@/components/ui/dialog";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import type { ServerView } from "@/server/servers";
import { connectRepo } from "@/server/services";

interface Props {
  environmentName?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectName?: string;
  servers: ServerView[];
}

interface ConnectRepoFormValues {
  environmentName: string;
  name: string;
  projectName: string;
  serverId: string;
}

export function ConnectRepoDialog({
  environmentName: lockedEnvironment,
  onOpenChange,
  open,
  projectName: lockedProject,
  servers,
}: Props) {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();

  const connect = useMutation({
    mutationFn: (value: ConnectRepoFormValues) =>
      connectRepo({
        data: {
          environmentName: value.environmentName,
          name: value.name,
          projectName: value.projectName,
          serverId: value.serverId,
        },
      }),
    onSuccess: async (created) => {
      onOpenChange(false);
      await queryClient.invalidateQueries({
        queryKey: queries.servers().queryKey,
      });
      await router.invalidate();
      await navigate({
        params: {
          environmentId: created.environmentId,
          projectId: created.projectId,
          serviceId: created.serviceId,
        },
        to: "/projects/$projectId/$environmentId/services/$serviceId",
      });
    },
  });
  const defaultServerId = servers[0]?.id ?? "";
  const defaultValues: ConnectRepoFormValues = {
    environmentName: lockedEnvironment ?? "production",
    name: "",
    projectName: lockedProject ?? "default",
    serverId: defaultServerId,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => connect.mutateAsync(value),
    validators: { onDynamic: connectRepoSchema },
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form.reset]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  const noServers = servers.length === 0;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New application</DialogTitle>
          <DialogDescription>
            Name it here. Its source and build are configured on the next
            screen, then you deploy.
          </DialogDescription>
        </DialogHeader>

        {noServers ? (
          <NoServersEmpty description="An application needs a machine to build and run on." />
        ) : (
          <DialogForm onSubmit={handleSubmit}>
            <DialogBody>
              <FieldGroup>
                <FieldSet>
                  <FieldLegend variant="label">Location</FieldLegend>
                  {lockedProject && lockedEnvironment ? null : (
                    <div className="grid grid-cols-2 gap-4">
                      <form.AppField name="projectName">
                        {(f) => <f.FieldText label="Project" required />}
                      </form.AppField>
                      <form.AppField name="environmentName">
                        {(f) => <f.FieldText label="Environment" required />}
                      </form.AppField>
                    </div>
                  )}

                  <form.AppField name="name">
                    {(f) => (
                      <f.FieldText label="Name" placeholder="my-app" required />
                    )}
                  </form.AppField>

                  <form.AppField name="serverId">
                    {(f) => (
                      <f.FieldCombobox
                        emptyText="No server matches."
                        items={servers}
                        itemToId={(server) => server.id}
                        itemToStringLabel={(server) => server.name}
                        itemToStringValue={(server) =>
                          `${server.name} · ${server.host}`
                        }
                        label="Server"
                        placeholder="Search servers…"
                        renderItem={(server) => (
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate">{server.name}</span>
                            <span className="font-normal text-muted-foreground text-xs">
                              {server.host}
                            </span>
                          </span>
                        )}
                      />
                    )}
                  </form.AppField>
                </FieldSet>

                {connect.isError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {errorMessage(connect.error, "could not create")}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            </DialogBody>

            <DialogFooter>
              <Button disabled={connect.isPending} type="submit">
                {connect.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                Create
              </Button>
            </DialogFooter>
          </DialogForm>
        )}
      </DialogContent>
    </Dialog>
  );
}
