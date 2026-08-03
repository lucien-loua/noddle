import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
    (e: ChangeEvent<HTMLSelectElement>) => setServerId(e.target.value),
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
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field orientation="horizontal">
                <div className="flex-1">
                  <FieldLabel htmlFor="repo-project">Projet</FieldLabel>
                  <Input
                    id="repo-project"
                    onChange={handleProjectChange}
                    required
                    value={projectName}
                  />
                </div>
                <div className="flex-1">
                  <FieldLabel htmlFor="repo-env">Environnement</FieldLabel>
                  <Input
                    id="repo-env"
                    onChange={handleEnvChange}
                    required
                    value={environmentName}
                  />
                </div>
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
                <select
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  id="repo-server"
                  onChange={handleServerChange}
                  required
                  value={serverId}
                >
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.host})
                    </option>
                  ))}
                </select>
              </Field>

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

              <Field orientation="horizontal">
                <div className="flex-[2]">
                  <FieldLabel htmlFor="repo-branch">Branche</FieldLabel>
                  <Input
                    id="repo-branch"
                    onChange={handleBranchChange}
                    value={gitBranch}
                  />
                </div>
                <div className="flex-1">
                  <FieldLabel htmlFor="repo-port">Port</FieldLabel>
                  <Input
                    id="repo-port"
                    inputMode="numeric"
                    onChange={handlePortChange}
                    value={port}
                  />
                </div>
              </Field>

              <Field>
                <FieldLabel htmlFor="repo-domain">
                  Domaine (optionnel)
                </FieldLabel>
                <Input
                  id="repo-domain"
                  onChange={handleDomainChange}
                  placeholder="mon-app.exemple.com"
                  value={domain}
                />
              </Field>

              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>

            <DialogFooter className="mt-6">
              <Button disabled={pending} type="submit">
                {pending ? <Spinner data-icon="inline-start" /> : null}
                Connecter
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
