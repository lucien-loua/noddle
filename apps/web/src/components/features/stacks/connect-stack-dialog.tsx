import { domainSchema } from "@noddle/shared/validation/service";
import {
  composeServiceKeySchema,
  connectStackBaseSchema,
} from "@noddle/shared/validation/stack";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect } from "react";
import { z } from "zod";

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
import { connectStack } from "@/server/stacks";

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

const connectStackFormSchema = connectStackBaseSchema
  .extend({
    domain: z
      .string()
      .refine(
        (v) => v === "" || domainSchema.safeParse(v).success,
        "Enter a valid domain, or leave empty."
      ),
    port: z.number().int().min(1).max(65_535).nullable(),
    publicService: z
      .string()
      .refine(
        (v) => v === "" || composeServiceKeySchema.safeParse(v).success,
        "Enter a valid service key, or leave empty."
      ),
  })
  .refine((v) => !v.publicService || v.port !== null, {
    message: "A port is required to expose a service.",
    path: ["port"],
  });

type ConnectStackFormValues = z.input<typeof connectStackFormSchema>;

export function ConnectStackDialog({
  environmentName: lockedEnvironment,
  onOpenChange,
  open,
  projectName: lockedProject,
  servers,
}: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const connect = useMutation({
    mutationFn: (value: ConnectStackFormValues) =>
      connectStack({
        data: {
          composeFilePath: value.composeFilePath || "docker-compose.yml",
          domain: value.domain || undefined,
          environmentName: value.environmentName,
          gitBranch: value.gitBranch || "main",
          gitRepoUrl: value.gitRepoUrl,
          name: value.name,
          port: value.port ?? undefined,
          projectName: value.projectName,
          publicService: value.publicService || undefined,
          serverId: value.serverId,
        },
      }),
    onSuccess: async () => {
      onOpenChange(false);
      await queryClient.invalidateQueries({
        queryKey: queries.servers().queryKey,
      });
      await router.invalidate();
    },
  });

  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive, servers can be empty
  const defaultServerId = servers[0]?.id ?? "";
  const defaultValues: ConnectStackFormValues = {
    composeFilePath: "docker-compose.yml",
    domain: "",
    environmentName: lockedEnvironment ?? "production",
    gitBranch: "main",
    gitRepoUrl: "",
    name: "",
    port: null,
    projectName: lockedProject ?? "default",
    publicService: "",
    serverId: defaultServerId,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => connect.mutateAsync(value),
    validators: { onDynamic: connectStackFormSchema },
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
          <DialogTitle>Connect a Compose stack</DialogTitle>
          <DialogDescription>
            Noddle clones the repository, builds every service that has a{" "}
            <code>build:</code>, and lays the whole thing down with{" "}
            <code>docker stack deploy</code> on the chosen server.
          </DialogDescription>
        </DialogHeader>

        {noServers ? (
          <NoServersEmpty description="A Compose stack needs a machine to build and run on." />
        ) : (
          <DialogForm onSubmit={handleSubmit}>
            <DialogBody>
              {/* Ten flat fields forced you to read each label to know
                  what's being asked. Three groups each answer one
                  question: where it lives, where the code comes from, what
                  gets exposed. */}
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
                        label="Stack name"
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
                        // Deliberately inline: `server` is inferred from
                        // `items={servers}` in the same JSX call.
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference, see above
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

                  <div className="grid grid-cols-[1fr_2fr] gap-4">
                    <form.AppField name="gitBranch">
                      {(f) => <f.FieldText label="Branch" />}
                    </form.AppField>
                    <form.AppField name="composeFilePath">
                      {(f) => <f.FieldText label="Compose file" />}
                    </form.AppField>
                  </div>
                </FieldSet>

                <FieldSet>
                  <FieldLegend variant="label">Public access</FieldLegend>
                  <p className="text-muted-foreground text-sm">
                    A stack exposes at most one service to the web. Left empty,
                    nothing is published: the stack runs without being reachable
                    from outside.
                  </p>

                  <form.AppField name="publicService">
                    {(f) => (
                      <f.FieldText
                        label="Service to expose"
                        placeholder="web"
                      />
                    )}
                  </form.AppField>

                  <div className="grid grid-cols-[1fr_2fr] gap-4">
                    <form.AppField name="port">
                      {(f) => <f.FieldNumber label="Port" min={1} />}
                    </form.AppField>
                    <form.AppField name="domain">
                      {(f) => (
                        <f.FieldText
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
