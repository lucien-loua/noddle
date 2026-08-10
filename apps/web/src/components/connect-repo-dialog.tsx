import { connectRepoSchema, domainSchema } from "@noddle/shared/validation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect } from "react";
import { z } from "zod";
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
import type { ServerView } from "@/server/servers";
import { connectRepo } from "@/server/services";

interface Props {
  /**
   * The project and environment, when the calling screen ALREADY KNOWS
   * them — an environment's page. The corresponding fields then disappear:
   * asking someone again for the project they're already in is the
   * inconsistency this component fixes.
   */
  environmentName?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectName?: string;
  servers: ServerView[];
}

const connectRepoFormSchema = connectRepoSchema.extend({
  domain: z
    .string()
    .refine(
      (v) => v === "" || domainSchema.safeParse(v).success,
      "Enter a valid domain, or leave empty."
    ),
  port: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .nullable()
    .refine((v) => v !== null, "Port is required."),
});

type ConnectRepoFormValues = z.input<typeof connectRepoFormSchema>;

export function ConnectRepoDialog({
  environmentName: lockedEnvironment,
  onOpenChange,
  open,
  projectName: lockedProject,
  servers,
}: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const connect = useMutation({
    mutationFn: (value: ConnectRepoFormValues) =>
      connectRepo({
        data: {
          domain: value.domain || undefined,
          environmentName: value.environmentName,
          gitBranch: value.gitBranch,
          gitRepoUrl: value.gitRepoUrl,
          name: value.name,
          port: value.port ?? 3000,
          projectName: value.projectName,
          serverId: value.serverId,
        },
      }),
    onSuccess: async () => {
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
      await router.invalidate();
    },
  });
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive, servers can be empty
  const defaultServerId = servers[0]?.id ?? "";
  const defaultValues: ConnectRepoFormValues = {
    domain: "",
    environmentName: lockedEnvironment ?? "production",
    gitBranch: "main",
    gitRepoUrl: "",
    name: "",
    port: 3000,
    projectName: lockedProject ?? "default",
    serverId: defaultServerId,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => connect.mutateAsync(value),
    validators: { onDynamic: connectRepoFormSchema },
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
          <DialogTitle>Connect a repository</DialogTitle>
          <DialogDescription>
            Noddle clones the repository, detects the stack with nixpacks, and
            builds the image on the chosen server.
          </DialogDescription>
        </DialogHeader>

        {noServers ? (
          <Alert variant="destructive">
            <AlertDescription>
              No servers registered. Add one before connecting a repository — a
              service needs a machine to build and run on.
            </AlertDescription>
          </Alert>
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
                      <f.FieldText
                        label="Service name"
                        placeholder="my-app"
                        required
                      />
                    )}
                  </form.AppField>

                  <form.AppField name="serverId">
                    {(f) => (
                      <f.FieldCombobox
                        emptyText="No server matches."
                        items={servers}
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                        itemToId={(server) => server.id}
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                        itemToStringLabel={(server) => server.name}
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                        itemToStringValue={(server) =>
                          `${server.name} · ${server.host}`
                        }
                        label="Server"
                        placeholder="Search servers…"
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
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

                <FieldSet>
                  <FieldLegend variant="label">Source</FieldLegend>
                  <form.AppField name="gitRepoUrl">
                    {(f) => (
                      <f.FieldText
                        label="Git repository URL"
                        placeholder="https://github.com/me/my-app.git"
                        required
                      />
                    )}
                  </form.AppField>

                  <form.AppField name="gitBranch">
                    {(f) => <f.FieldText label="Branch" />}
                  </form.AppField>
                </FieldSet>

                <FieldSet>
                  <FieldLegend variant="label">Public access</FieldLegend>
                  <div className="grid grid-cols-[1fr_1fr] gap-4">
                    <form.AppField name="port">
                      {(f) => (
                        <f.FieldNumber
                          description="The port your app listens on."
                          label="Port"
                          min={1}
                        />
                      )}
                    </form.AppField>
                    <form.AppField name="domain">
                      {(f) => (
                        <f.FieldText
                          description="Without a domain, the service isn't reachable from outside."
                          label="Domain"
                          placeholder="my-app.example.com"
                        />
                      )}
                    </form.AppField>
                  </div>
                </FieldSet>

                {connect.isError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {errorMessage(connect.error, "could not connect")}
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
                Connect
              </Button>
            </DialogFooter>
          </DialogForm>
        )}
      </DialogContent>
    </Dialog>
  );
}
