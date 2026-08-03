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
import { connectDatabase } from "@/server/databases";
import type { ServerView } from "@/server/servers";

interface Props {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  servers: ServerView[];
}

export function ConnectDatabaseDialog({ onOpenChange, open, servers }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("défaut");
  const [environmentName, setEnvironmentName] = useState("production");
  const [engine, setEngine] = useState<"postgres" | "redis">("postgres");
  const [name, setName] = useState("");
  // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif, servers peut être vide
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");

  const handleProjectChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setProjectName(e.target.value),
    []
  );
  const handleEnvChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setEnvironmentName(e.target.value),
    []
  );
  const handleEngineChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) =>
      setEngine(e.target.value as "postgres" | "redis"),
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

  const reset = useCallback(() => {
    setProjectName("défaut");
    setEnvironmentName("production");
    setEngine("postgres");
    setName("");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif, servers peut être vide
    setServerId(servers[0]?.id ?? "");
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
        await connectDatabase({
          data: { engine, environmentName, name, projectName, serverId },
        });
        onOpenChange(false);
        await router.invalidate();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
    },
    [engine, environmentName, name, onOpenChange, projectName, router, serverId]
  );

  const noServers = servers.length === 0;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connecter une base de données</DialogTitle>
          <DialogDescription>
            Noddle démarre un conteneur officiel avec un volume dédié sur le
            serveur choisi. Le mot de passe est généré et ne s'affiche jamais :
            attachez la base à un service pour lui donner accès.
          </DialogDescription>
        </DialogHeader>

        {noServers ? (
          <Alert variant="destructive">
            <AlertDescription>
              Aucun serveur enregistré. Ajoutez-en un avant de connecter une
              base de données.
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field orientation="horizontal">
                <div className="flex-1">
                  <FieldLabel htmlFor="db-project">Projet</FieldLabel>
                  <Input
                    id="db-project"
                    onChange={handleProjectChange}
                    required
                    value={projectName}
                  />
                </div>
                <div className="flex-1">
                  <FieldLabel htmlFor="db-env">Environnement</FieldLabel>
                  <Input
                    id="db-env"
                    onChange={handleEnvChange}
                    required
                    value={environmentName}
                  />
                </div>
              </Field>

              <Field orientation="horizontal">
                <div className="flex-1">
                  <FieldLabel htmlFor="db-engine">Moteur</FieldLabel>
                  <select
                    className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    id="db-engine"
                    onChange={handleEngineChange}
                    value={engine}
                  >
                    <option value="postgres">PostgreSQL</option>
                    <option value="redis">Redis</option>
                  </select>
                </div>
                <div className="flex-1">
                  <FieldLabel htmlFor="db-name">Nom</FieldLabel>
                  <Input
                    id="db-name"
                    onChange={handleNameChange}
                    placeholder="ma-base"
                    required
                    value={name}
                  />
                </div>
              </Field>

              <Field>
                <FieldLabel htmlFor="db-server">Serveur</FieldLabel>
                <select
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  id="db-server"
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
