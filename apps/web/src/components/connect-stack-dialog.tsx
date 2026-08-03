// Connecter une pile Compose — plusieurs conteneurs sous un même nom.
//
// AU PLUS un service de la pile reçoit une route Traefik (« service public » +
// domaine + port) : c'est le cas courant que Compose sert, app + à-côtés, pas
// N domaines par pile. Les autres conteneurs (un worker, un Redis à soi) n'ont
// besoin d'aucun champ ici.
import { PlusIcon } from "@phosphor-icons/react";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ServerView } from "@/server/servers";
import { connectStack } from "@/server/stacks";

interface Props {
  servers: ServerView[];
}

export function ConnectStackDialog({ servers }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("défaut");
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
    setProjectName("défaut");
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
    async (event: FormEvent) => {
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
        setOpen(false);
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
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon data-icon="inline-start" />
        Connecter une pile Compose
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connecter une pile Compose</DialogTitle>
          <DialogDescription>
            Noddle clone le dépôt, construit chaque service avec un{" "}
            <code>build:</code>, et pose l'ensemble avec{" "}
            <code>docker stack deploy</code> sur le serveur choisi.
          </DialogDescription>
        </DialogHeader>

        {noServers ? (
          <Alert variant="destructive">
            <AlertDescription>
              Aucun serveur enregistré. Ajoutez-en un avant de connecter une
              pile : elle a besoin d'une machine où construire et tourner.
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field orientation="horizontal">
                <div className="flex-1">
                  <FieldLabel htmlFor="stack-project">Projet</FieldLabel>
                  <Input
                    id="stack-project"
                    onChange={handleProjectChange}
                    required
                    value={projectName}
                  />
                </div>
                <div className="flex-1">
                  <FieldLabel htmlFor="stack-env">Environnement</FieldLabel>
                  <Input
                    id="stack-env"
                    onChange={handleEnvChange}
                    required
                    value={environmentName}
                  />
                </div>
              </Field>

              <Field>
                <FieldLabel htmlFor="stack-name">Nom de la pile</FieldLabel>
                <Input
                  id="stack-name"
                  onChange={handleNameChange}
                  placeholder="mon-app"
                  required
                  value={name}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="stack-server">Serveur</FieldLabel>
                <select
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  id="stack-server"
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
                <FieldLabel htmlFor="stack-url">URL du dépôt Git</FieldLabel>
                <Input
                  id="stack-url"
                  onChange={handleUrlChange}
                  placeholder="https://github.com/moi/mon-app.git"
                  required
                  value={gitRepoUrl}
                />
              </Field>

              <Field orientation="horizontal">
                <div className="flex-1">
                  <FieldLabel htmlFor="stack-branch">Branche</FieldLabel>
                  <Input
                    id="stack-branch"
                    onChange={handleBranchChange}
                    value={gitBranch}
                  />
                </div>
                <div className="flex-[2]">
                  <FieldLabel htmlFor="stack-compose-path">
                    Fichier compose
                  </FieldLabel>
                  <Input
                    id="stack-compose-path"
                    onChange={handleComposePathChange}
                    value={composeFilePath}
                  />
                </div>
              </Field>

              <Field>
                <FieldLabel htmlFor="stack-public-service">
                  Service public (optionnel)
                </FieldLabel>
                <Input
                  id="stack-public-service"
                  onChange={handlePublicServiceChange}
                  placeholder="web"
                  value={publicService}
                />
              </Field>

              <Field orientation="horizontal">
                <div className="flex-1">
                  <FieldLabel htmlFor="stack-port">
                    Port du service public
                  </FieldLabel>
                  <Input
                    id="stack-port"
                    inputMode="numeric"
                    onChange={handlePortChange}
                    placeholder="3000"
                    value={port}
                  />
                </div>
                <div className="flex-[2]">
                  <FieldLabel htmlFor="stack-domain">
                    Domaine (optionnel)
                  </FieldLabel>
                  <Input
                    id="stack-domain"
                    onChange={handleDomainChange}
                    placeholder="mon-app.exemple.com"
                    value={domain}
                  />
                </div>
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
