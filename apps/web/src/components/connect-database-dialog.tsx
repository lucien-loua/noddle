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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { connectDatabase } from "@/server/databases";
import type { ServerView } from "@/server/servers";

/** `items` : sans lui, Base UI afficherait la valeur brute (« postgres »)
 *  au lieu du nom du produit. */
const ENGINE_LABELS: Record<string, string> = {
  postgres: "PostgreSQL",
  redis: "Redis",
};

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
  const handleEngineChange = useCallback((next: unknown) => {
    if (next === "postgres" || next === "redis") {
      setEngine(next);
    }
  }, []);
  const handleNameChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );
  const handleServerChange = useCallback(
    (next: string) => setServerId(next),
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
          <DialogForm onSubmit={handleSubmit}>
            <DialogBody>
              <FieldGroup>
                <Field orientation="horizontal">
                  <Field className="flex-1">
                    <FieldLabel htmlFor="db-project">Projet</FieldLabel>
                    <Input
                      id="db-project"
                      onChange={handleProjectChange}
                      required
                      value={projectName}
                    />
                  </Field>
                  <Field className="flex-1">
                    <FieldLabel htmlFor="db-env">Environnement</FieldLabel>
                    <Input
                      id="db-env"
                      onChange={handleEnvChange}
                      required
                      value={environmentName}
                    />
                  </Field>
                </Field>

                <Field orientation="horizontal">
                  <Field className="flex-1">
                    <FieldLabel htmlFor="db-engine">Moteur</FieldLabel>
                    <Select
                      items={ENGINE_LABELS}
                      onValueChange={handleEngineChange}
                      value={engine}
                    >
                      <SelectTrigger className="w-full" id="db-engine">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="postgres">PostgreSQL</SelectItem>
                          <SelectItem value="redis">Redis</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field className="flex-1">
                    <FieldLabel htmlFor="db-name">Nom</FieldLabel>
                    <Input
                      id="db-name"
                      onChange={handleNameChange}
                      placeholder="ma-base"
                      required
                      value={name}
                    />
                  </Field>
                </Field>

                <Field>
                  <FieldLabel htmlFor="db-server">Serveur</FieldLabel>
                  <ServerSelect
                    id="db-server"
                    onChange={handleServerChange}
                    servers={servers}
                    value={serverId}
                  />
                </Field>

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
