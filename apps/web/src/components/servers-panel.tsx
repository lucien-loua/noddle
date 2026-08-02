// Les serveurs cibles : liste compacte, et le formulaire d'ajout.
//
// Volontairement à part du tableau des services : « chaque service visible
// d'un coup d'œil » ne veut pas dire que la topologie des serveurs doit vivre
// sur le même écran principal — mais ça reste ICI, pas une route séparée, pour
// ne pas ajouter de page à un outil qui refuse d'en ajouter.
import { PlusIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { badgeVariant, dotClass } from "@/lib/format";
import { cn } from "@/lib/utils";
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
  connected: "Connecté",
  pending: "Provisionnement…",
  unreachable: "Injoignable",
};

/** Un serveur `pending` ne le reste que le temps du provisionnement — quelques
 *  dizaines de secondes. Le sondage s'arrête tout seul une fois qu'il n'y en a
 *  plus, pour ne pas cogner Redis/Postgres en continu sans raison. */
const POLL_MS = 3000;

function ServerRow({ server }: { server: ServerView }) {
  const tone = statusTone(server.status);
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
      <span
        aria-label={STATUS_LABEL[server.status]}
        className={cn("size-2 shrink-0 rounded-full", dotClass(tone))}
        role="img"
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{server.name}</span>{" "}
        <span className="text-muted-foreground text-xs">
          {server.host}
          {server.role === "manager" ? " · manager" : ""}
          {server.dockerVersion ? ` · Docker ${server.dockerVersion}` : ""}
        </span>
      </span>
      <Badge variant={badgeVariant(tone)}>{STATUS_LABEL[server.status]}</Badge>
    </div>
  );
}

export function ServersPanel({ initial }: { initial: ServerView[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const serversQuery = useQuery({
    initialData: initial,
    queryFn: () => getServers(),
    queryKey: ["servers"],
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "pending") ? POLL_MS : false,
  });
  const servers = serversQuery.data ?? initial;

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
      setOpen(false);
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

  const unreachable = servers.filter(
    (s) => s.status === "unreachable" && s.lastError
  );

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-medium text-muted-foreground text-sm">Serveurs</h2>

        <Dialog onOpenChange={setOpen} open={open}>
          <DialogTrigger render={<Button size="sm" variant="outline" />}>
            <PlusIcon data-icon="inline-start" />
            Ajouter un serveur
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Ajouter un serveur</DialogTitle>
              <DialogDescription>
                Un hôte et une clé SSH suffisent. Noddle installe Docker si
                besoin, rejoint son cluster Swarm en tant que worker, et
                installe nixpacks — sans rien d'autre à faire à la main sur
                cette machine.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="server-name">Nom</FieldLabel>
                  <Input
                    id="server-name"
                    onChange={handleNameChange}
                    placeholder="vps-lyon"
                    required
                    value={name}
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="server-host">Hôte</FieldLabel>
                  <Input
                    id="server-host"
                    onChange={handleHostChange}
                    placeholder="203.0.113.7"
                    required
                    value={host}
                  />
                </Field>

                <Field orientation="horizontal">
                  <div className="flex-3">
                    <FieldLabel htmlFor="server-user">
                      Utilisateur SSH
                    </FieldLabel>
                    <Input
                      id="server-user"
                      onChange={handleUserChange}
                      required
                      value={sshUser}
                    />
                  </div>
                  <div className="flex-1">
                    <FieldLabel htmlFor="server-port">Port</FieldLabel>
                    <Input
                      id="server-port"
                      inputMode="numeric"
                      onChange={handlePortChange}
                      value={sshPort}
                    />
                  </div>
                </Field>

                <Field>
                  <FieldLabel htmlFor="server-key">
                    Clé privée SSH (PEM)
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

                {formError ? (
                  <Alert variant="destructive">
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>

              <DialogFooter className="mt-6">
                <Button disabled={add.isPending} type="submit">
                  {add.isPending ? <Spinner data-icon="inline-start" /> : null}
                  Ajouter
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-col gap-2">
        {servers.map((server) => (
          <ServerRow key={server.id} server={server} />
        ))}

        {unreachable.length > 0 ? (
          <div className="flex flex-col gap-1">
            {unreachable.map((s) => (
              <p className="px-1 text-destructive text-xs" key={s.id}>
                {s.name} : {s.lastError}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
