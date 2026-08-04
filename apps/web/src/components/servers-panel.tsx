// Les serveurs cibles : même langage de ligne que tout le reste.
//
// L'erreur d'un serveur injoignable vit DANS sa ligne, pas en texte rouge
// flottant sous la liste : une erreur détachée de ce qu'elle décrit oblige à
// relire les deux pour faire le lien.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { ResourceRow, RowGroup } from "@/components/resource-row";
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
import { Textarea } from "@/components/ui/textarea";
import { addServer, getServers, type ServerView } from "@/server/servers";

/** Le badge et la pastille partagent le même vocabulaire que les services :
 *  « connecté » se lit comme « en service », sans nouveau code de couleur à
 *  apprendre pour cet écran-là. */
function statusTone(status: ServerView["status"]) {
  if (status === "connected") {
    return "ok" as const;
  }
  if (status === "unreachable") {
    return "danger" as const;
  }
  return "busy" as const;
}

const STATUS_LABEL: Record<ServerView["status"], string> = {
  connected: "Connected",
  pending: "Provisioning…",
  unreachable: "Unreachable",
};

/** Un serveur `pending` ne le reste que le temps du provisionnement — quelques
 *  dizaines de secondes. Le sondage s'arrête tout seul une fois qu'il n'y en a
 *  plus, pour ne pas cogner Redis/Postgres en continu sans raison. */
const POLL_MS = 3000;

function ServerRow({ server }: { server: ServerView }) {
  const tone = statusTone(server.status);
  const facts = [
    server.host,
    server.role === "manager" ? "manager" : null,
    server.dockerVersion ? `Docker ${server.dockerVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ResourceRow
      name={server.name}
      secondary={
        server.status === "unreachable" && server.lastError ? (
          <span className="text-destructive">{server.lastError}</span>
        ) : (
          facts
        )
      }
      tone={tone}
      toneLabel={STATUS_LABEL[server.status]}
    />
  );
}

export function ServersList({ initial }: { initial: ServerView[] }) {
  const serversQuery = useQuery({
    initialData: initial,
    queryFn: () => getServers(),
    queryKey: ["servers"],
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "pending") ? POLL_MS : false,
  });
  const servers = serversQuery.data ?? initial;

  if (servers.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No servers yet. Add one before you can deploy anything.
      </p>
    );
  }

  return (
    <RowGroup>
      {servers.map((server) => (
        <ServerRow key={server.id} server={server} />
      ))}
    </RowGroup>
  );
}

export function AddServerDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState("22");
  const [privateKey, setPrivateKey] = useState("");

  const handleNameChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );
  const handleHostChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setHost(e.target.value),
    []
  );
  const handleUserChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setSshUser(e.target.value),
    []
  );
  const handlePortChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setSshPort(e.target.value),
    []
  );
  const handleKeyChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => setPrivateKey(e.target.value),
    []
  );

  const reset = useCallback(() => {
    setName("");
    setHost("");
    setSshUser("root");
    setSshPort("22");
    setPrivateKey("");
    setFormError(null);
  }, []);

  const add = useMutation({
    mutationFn: () =>
      addServer({
        data: {
          host,
          name,
          privateKey,
          sshPort: Number(sshPort) || 22,
          sshUser,
        },
      }),
    onError: (error: Error) => setFormError(error.message),
    onSuccess: async () => {
      reset();
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
  });

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      setFormError(null);
      add.mutate();
    },
    [add]
  );

  // Un formulaire jamais ouvert deux fois de suite dans le même état : fermer
  // sans enregistrer doit repartir vierge à la prochaine ouverture.
  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            A host and an SSH key are all it takes. Noddle installs Docker if
            missing, joins its Swarm cluster as a worker, and installs nixpacks
            — with nothing else to do by hand on that machine.
          </DialogDescription>
        </DialogHeader>

        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <FieldSet>
                <FieldLegend variant="label">Machine</FieldLegend>
                <Field>
                  <FieldLabel htmlFor="server-name">Name</FieldLabel>
                  <Input
                    id="server-name"
                    onChange={handleNameChange}
                    placeholder="vps-lyon"
                    required
                    value={name}
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="server-host">Host</FieldLabel>
                  <Input
                    id="server-host"
                    onChange={handleHostChange}
                    placeholder="203.0.113.7"
                    required
                    value={host}
                  />
                </Field>

                <Field orientation="horizontal">
                  <Field className="flex-3">
                    <FieldLabel htmlFor="server-user">SSH user</FieldLabel>
                    <Input
                      id="server-user"
                      onChange={handleUserChange}
                      required
                      value={sshUser}
                    />
                  </Field>
                  <Field className="flex-1">
                    <FieldLabel htmlFor="server-port">Port</FieldLabel>
                    <Input
                      id="server-port"
                      inputMode="numeric"
                      onChange={handlePortChange}
                      value={sshPort}
                    />
                  </Field>
                </Field>
              </FieldSet>

              {/* La clé a son propre groupe : c'est le seul champ qui pèse
                  plusieurs lignes, et le seul qui soit un secret. Le noyer
                  entre l'hôte et le port le faisait passer pour un réglage
                  de plus. */}
              <FieldSet>
                <FieldLegend variant="label">SSH private key</FieldLegend>
                <FieldDescription>
                  Encrypted at rest, it never leaves the server — not even
                  encrypted. Noddle uses it to reach this machine, nothing else.
                </FieldDescription>
                <Field>
                  <FieldLabel className="sr-only" htmlFor="server-key">
                    SSH private key, PEM format
                  </FieldLabel>
                  <Textarea
                    className="min-h-32 font-mono text-xs"
                    id="server-key"
                    onChange={handleKeyChange}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    required
                    spellCheck={false}
                    value={privateKey}
                  />
                </Field>
              </FieldSet>

              {formError ? (
                <Alert variant="destructive">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>

          <DialogFooter>
            <Button disabled={add.isPending} type="submit">
              {add.isPending ? <Spinner data-icon="inline-start" /> : null}
              Add server
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
