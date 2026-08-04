import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { ServerSelect } from "@/components/server-select";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ServerView } from "@/server/servers";
import { connectStack } from "@/server/stacks";

interface Props {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  servers: ServerView[];
}

export function ConnectStackDialog({ onOpenChange, open, servers }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("default");
  const [environmentName, setEnvironmentName] = useState("production");
  const [name, setName] = useState("");
  // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif, servers peut être vide
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [composeFilePath, setComposeFilePath] = useState("docker-compose.yml");
  const [publicService, setPublicService] = useState("");
  const [port, setPort] = useState("");
  const [domain, setDomain] = useState("");

  const handleProjectChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setProjectName(e.target.value),
    []
  );
  const handleEnvChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setEnvironmentName(e.target.value),
    []
  );
  const handleNameChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );
  const handleServerChange = useCallback(
    (next: string) => setServerId(next),
    []
  );
  const handleUrlChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setGitRepoUrl(e.target.value),
    []
  );
  const handleBranchChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setGitBranch(e.target.value),
    []
  );
  const handleComposePathChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setComposeFilePath(e.target.value),
    []
  );
  const handlePublicServiceChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setPublicService(e.target.value),
    []
  );
  const handlePortChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setPort(e.target.value),
    []
  );
  const handleDomainChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setDomain(e.target.value),
    []
  );

  const reset = useCallback(() => {
    setProjectName("default");
    setEnvironmentName("production");
    setName("");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif, servers peut être vide
    setServerId(servers[0]?.id ?? "");
    setGitRepoUrl("");
    setGitBranch("main");
    setComposeFilePath("docker-compose.yml");
    setPublicService("");
    setPort("");
    setDomain("");
    setError(null);
  }, [servers]);

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  const handleSubmit = useCallback(
    async (event: React.SubmitEvent) => {
      event.preventDefault();
      setPending(true);
      setError(null);

      try {
        await connectStack({
          data: {
            composeFilePath,
            domain: domain || undefined,
            environmentName,
            gitBranch,
            gitRepoUrl,
            name,
            port: port ? Number(port) : undefined,
            projectName,
            publicService: publicService || undefined,
            serverId,
          },
        });
        onOpenChange(false);
        await queryClient.invalidateQueries({ queryKey: ["servers"] });
        await router.invalidate();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
    },
    [
      composeFilePath,
      domain,
      environmentName,
      gitBranch,
      gitRepoUrl,
      name,
      onOpenChange,
      port,
      projectName,
      publicService,
      queryClient,
      router,
      serverId,
    ]
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
          <Alert variant="destructive">
            <AlertDescription>
              No servers registered. Add one before connecting a stack — it
              needs a machine to build and run on.
            </AlertDescription>
          </Alert>
        ) : (
          <DialogForm onSubmit={handleSubmit}>
            <DialogBody>
              {/* Dix champs à plat obligeaient à lire chaque libellé pour
                  savoir de quoi on parle. Trois groupes répondent chacun à
                  une question : où ça vit, d'où vient le code, qu'est-ce
                  qu'on expose. */}
              <FieldGroup>
                <FieldSet>
                  <FieldLegend variant="label">Location</FieldLegend>
                  <Field orientation="horizontal">
                    <Field className="flex-1">
                      <FieldLabel htmlFor="stack-project">Project</FieldLabel>
                      <Input
                        id="stack-project"
                        onChange={handleProjectChange}
                        required
                        value={projectName}
                      />
                    </Field>
                    <Field className="flex-1">
                      <FieldLabel htmlFor="stack-env">Environment</FieldLabel>
                      <Input
                        id="stack-env"
                        onChange={handleEnvChange}
                        required
                        value={environmentName}
                      />
                    </Field>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="stack-name">Stack name</FieldLabel>
                    <Input
                      id="stack-name"
                      onChange={handleNameChange}
                      placeholder="my-app"
                      required
                      value={name}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="stack-server">Server</FieldLabel>
                    <ServerSelect
                      id="stack-server"
                      onChange={handleServerChange}
                      servers={servers}
                      value={serverId}
                    />
                  </Field>
                </FieldSet>

                <FieldSet>
                  <FieldLegend variant="label">Source</FieldLegend>
                  <Field>
                    <FieldLabel htmlFor="stack-url">
                      Git repository URL
                    </FieldLabel>
                    <Input
                      id="stack-url"
                      onChange={handleUrlChange}
                      placeholder="https://github.com/me/my-app.git"
                      required
                      value={gitRepoUrl}
                    />
                  </Field>

                  <Field orientation="horizontal">
                    <Field className="flex-1">
                      <FieldLabel htmlFor="stack-branch">Branch</FieldLabel>
                      <Input
                        id="stack-branch"
                        onChange={handleBranchChange}
                        value={gitBranch}
                      />
                    </Field>
                    <Field className="flex-2">
                      <FieldLabel htmlFor="stack-compose-path">
                        Compose file
                      </FieldLabel>
                      <Input
                        id="stack-compose-path"
                        onChange={handleComposePathChange}
                        value={composeFilePath}
                      />
                    </Field>
                  </Field>
                </FieldSet>

                <FieldSet>
                  <FieldLegend variant="label">Public access</FieldLegend>
                  <FieldDescription>
                    A stack exposes at most one service to the web. Left empty,
                    nothing is published — the stack runs without being
                    reachable from outside.
                  </FieldDescription>
                  <Field>
                    <FieldLabel htmlFor="stack-public-service">
                      Service to expose
                    </FieldLabel>
                    <Input
                      id="stack-public-service"
                      onChange={handlePublicServiceChange}
                      placeholder="web"
                      value={publicService}
                    />
                  </Field>

                  <Field orientation="horizontal">
                    <Field className="flex-1">
                      <FieldLabel htmlFor="stack-port">Port</FieldLabel>
                      <Input
                        id="stack-port"
                        inputMode="numeric"
                        onChange={handlePortChange}
                        placeholder="3000"
                        value={port}
                      />
                    </Field>
                    <Field className="flex-2">
                      <FieldLabel htmlFor="stack-domain">Domain</FieldLabel>
                      <Input
                        id="stack-domain"
                        onChange={handleDomainChange}
                        placeholder="my-app.example.com"
                        value={domain}
                      />
                    </Field>
                  </Field>
                </FieldSet>

                {error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            </DialogBody>

            <DialogFooter>
              <Button disabled={pending} type="submit">
                {pending ? <Spinner data-icon="inline-start" /> : null}
                Connect
              </Button>
            </DialogFooter>
          </DialogForm>
        )}
      </DialogContent>
    </Dialog>
  );
}
