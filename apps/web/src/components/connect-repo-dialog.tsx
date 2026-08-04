import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ChangeEvent, FormEvent } from "react";
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
import { connectRepo } from "@/server/services";

interface Props {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  servers: ServerView[];
}

export function ConnectRepoDialog({ onOpenChange, open, servers }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("défaut");
  const [environmentName, setEnvironmentName] = useState("production");
  const [name, setName] = useState("");
  // Biome n'applique pas `noUncheckedIndexedAccess` du tsconfig et croit
  // `servers[0]` toujours défini ; `servers` peut pourtant être vide, c'est
  // précisément ce que `noServers` vérifie plus bas.
  // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif, servers peut être vide
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [port, setPort] = useState("3000");
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
  const handlePortChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setPort(e.target.value),
    []
  );
  const handleDomainChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setDomain(e.target.value),
    []
  );

  const reset = useCallback(() => {
    setProjectName("défaut");
    setEnvironmentName("production");
    setName("");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif, servers peut être vide
    setServerId(servers[0]?.id ?? "");
    setGitRepoUrl("");
    setGitBranch("main");
    setPort("3000");
    setDomain("");
    setError(null);
  }, [servers]);

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setPending(true);
      setError(null);

      try {
        await connectRepo({
          data: {
            domain: domain || undefined,
            environmentName,
            gitBranch,
            gitRepoUrl,
            name,
            port: Number(port) || 3000,
            projectName,
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
      domain,
      environmentName,
      gitBranch,
      gitRepoUrl,
      name,
      onOpenChange,
      port,
      projectName,
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
          <DialogTitle>Connecter un dépôt</DialogTitle>
          <DialogDescription>
            Noddle clone le dépôt, détecte la stack avec nixpacks, et construit
            l'image sur le serveur choisi.
          </DialogDescription>
        </DialogHeader>

        {noServers ? (
          <Alert variant="destructive">
            <AlertDescription>
              Aucun serveur enregistré. Ajoutez-en un ci-dessous avant de
              connecter un dépôt : un service a besoin d'une machine où
              construire et tourner.
            </AlertDescription>
          </Alert>
        ) : (
          <DialogForm onSubmit={handleSubmit}>
            <DialogBody>
              <FieldGroup>
                <FieldSet>
                  <FieldLegend variant="label">Emplacement</FieldLegend>
                  <Field orientation="horizontal">
                    <Field className="flex-1">
                      <FieldLabel htmlFor="repo-project">Projet</FieldLabel>
                      <Input
                        id="repo-project"
                        onChange={handleProjectChange}
                        required
                        value={projectName}
                      />
                    </Field>
                    <Field className="flex-1">
                      <FieldLabel htmlFor="repo-env">Environnement</FieldLabel>
                      <Input
                        id="repo-env"
                        onChange={handleEnvChange}
                        required
                        value={environmentName}
                      />
                    </Field>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="repo-name">Nom du service</FieldLabel>
                    <Input
                      id="repo-name"
                      onChange={handleNameChange}
                      placeholder="mon-app"
                      required
                      value={name}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="repo-server">Serveur</FieldLabel>
                    <ServerSelect
                      id="repo-server"
                      onChange={handleServerChange}
                      servers={servers}
                      value={serverId}
                    />
                  </Field>
                </FieldSet>

                <FieldSet>
                  <FieldLegend variant="label">Source</FieldLegend>
                  <Field>
                    <FieldLabel htmlFor="repo-url">URL du dépôt Git</FieldLabel>
                    <Input
                      id="repo-url"
                      onChange={handleUrlChange}
                      placeholder="https://github.com/moi/mon-app.git"
                      required
                      value={gitRepoUrl}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="repo-branch">Branche</FieldLabel>
                    <Input
                      id="repo-branch"
                      onChange={handleBranchChange}
                      value={gitBranch}
                    />
                  </Field>
                </FieldSet>

                <FieldSet>
                  <FieldLegend variant="label">Service exposé</FieldLegend>
                  <FieldDescription>
                    Le port sur lequel votre application écoute. Sans domaine,
                    le service tourne sans être joignable de l'extérieur.
                  </FieldDescription>
                  <Field orientation="horizontal">
                    <Field className="flex-1">
                      <FieldLabel htmlFor="repo-port">Port</FieldLabel>
                      <Input
                        id="repo-port"
                        inputMode="numeric"
                        onChange={handlePortChange}
                        value={port}
                      />
                    </Field>
                    <Field className="flex-2">
                      <FieldLabel htmlFor="repo-domain">Domaine</FieldLabel>
                      <Input
                        id="repo-domain"
                        onChange={handleDomainChange}
                        placeholder="mon-app.exemple.com"
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
                Connecter
              </Button>
            </DialogFooter>
          </DialogForm>
        )}
      </DialogContent>
    </Dialog>
  );
}
