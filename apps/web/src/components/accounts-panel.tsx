// Les comptes de l'installation.
//
// Le mot de passe d'un compte créé s'affiche UNE SEULE FOIS — même règle que
// le secret d'un webhook : il doit sortir vers un tiers, donc il se montre à
// sa génération et n'est jamais relu. Contrairement au mot de passe d'une base
// de données, qui n'a aucun tiers à qui être donné et ne sort donc jamais.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, relativeTime } from "@/lib/format";
import {
  ROLE_LABELS,
  ROLE_ORDER,
  type RoleName,
  roles,
} from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import {
  type AccountRow,
  createAccount,
  getAccounts,
  removeAccount,
  setAccountRole,
} from "@/server/accounts";

export function AccountsPanel({
  initial,
  role,
}: {
  initial: AccountRow[];
  role: string | null;
}) {
  // La session rend un `string` : on le confronte aux rôles connus ici, une
  // fois, plutôt que de le forcer à chaque appel.
  const known = role && role in roles ? (role as RoleName) : null;
  // Politesse, pas sécurité : le serveur refuse de toute façon. Ne pas
  // proposer une action interdite évite surtout de faire cliquer quelqu'un
  // vers un message d'erreur.
  const canCreate = useCan(known, "user", "create");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const accounts = useQuery({
    initialData: initial,
    queryFn: () => getAccounts(),
    queryKey: ["accounts"],
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    [queryClient]
  );
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Un rôle décide de ce qu'un compte peut faire, jamais de ce qu'il peut
          voir : tout le monde lit le même tableau de bord.
        </p>
        {canCreate ? (
          <Button onClick={handleOpen} size="sm">
            Créer un compte
          </Button>
        ) : null}
      </div>

      <CreateAccountDialog
        onDone={refresh}
        onOpenChange={setOpen}
        open={open}
      />

      <div className="divide-y rounded-md border">
        {(accounts.data ?? []).map((account) => (
          <AccountLine
            account={account}
            canManage={canCreate}
            key={account.id}
            onDone={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function AccountLine({
  account,
  canManage,
  onDone,
}: {
  account: AccountRow;
  canManage: boolean;
  onDone: () => void;
}) {
  const setRole = useMutation({
    mutationFn: (role: RoleName) =>
      setAccountRole({ data: { role, userId: account.id } }),
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => removeAccount({ data: { userId: account.id } }),
    onSuccess: onDone,
  });

  const handleRemove = useCallback(() => remove.mutate(), [remove]);
  const error = setRole.error ?? remove.error;

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{account.name}</span>
          {account.isSelf ? <Badge variant="outline">vous</Badge> : null}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {account.email} · créé {relativeTime(account.createdAt)}
        </span>
        {error ? (
          <span className="text-destructive text-xs">
            {errorMessage(error, "action refusée")}
          </span>
        ) : null}
      </span>

      <div className="flex gap-1">
        {(canManage ? ROLE_ORDER : []).map((role) => (
          <RoleButton
            active={account.role === role}
            key={role}
            onSelect={setRole.mutate}
            role={role}
          />
        ))}
      </div>

      {/* Se supprimer soi-même est refusé côté serveur ; le bouton disparaît
          pour que l'interface ne propose pas ce qu'elle sait impossible. */}
      {account.isSelf || !canManage ? null : (
        <Button
          disabled={remove.isPending}
          onClick={handleRemove}
          size="sm"
          variant="ghost"
        >
          Retirer
        </Button>
      )}
    </div>
  );
}

function RoleButton({
  active,
  onSelect,
  role,
}: {
  active: boolean;
  onSelect: (role: RoleName) => void;
  role: RoleName;
}) {
  const handleClick = useCallback(() => onSelect(role), [onSelect, role]);
  return (
    <Button
      onClick={handleClick}
      size="sm"
      variant={active ? "secondary" : "ghost"}
    >
      {ROLE_LABELS[role]}
    </Button>
  );
}

function CreateAccountDialog({
  onDone,
  onOpenChange,
  open,
}: {
  onDone: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<RoleName>("viewer");
  const [password, setPassword] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createAccount({ data: { email, name, role } }),
    onSuccess: (result) => {
      setPassword(result.password);
      setEmail("");
      setName("");
      onDone();
    },
  });

  const handleSubmit = useCallback(
    (event: React.SubmitEvent) => {
      event.preventDefault();
      create.mutate();
    },
    [create]
  );
  const handleEmail = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value),
    []
  );
  const handleName = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );
  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) {
        // Le mot de passe part avec la boîte : le relire est impossible, et
        // le laisser à l'écran donnerait l'illusion qu'on peut y revenir.
        setPassword(null);
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent>
        {password ? (
          <>
            <DialogHeader>
              <DialogTitle>Compte créé</DialogTitle>
              <DialogDescription>
                Voici son mot de passe. Il n'est affiché qu'une fois et ne peut
                pas être relu — transmettez-le maintenant.
              </DialogDescription>
            </DialogHeader>
            <code className="block break-all rounded-md bg-muted p-3 font-mono text-sm">
              {password}
            </code>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Créer un compte</DialogTitle>
              <DialogDescription>
                Le mot de passe est généré par Noddle et affiché une seule fois.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="accountName">Nom</Label>
                <Input
                  id="accountName"
                  onChange={handleName}
                  required
                  value={name}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accountEmail">Adresse e-mail</Label>
                <Input
                  id="accountEmail"
                  onChange={handleEmail}
                  required
                  type="email"
                  value={email}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accountRole">Rôle</Label>
                <div className="flex gap-1" id="accountRole">
                  {ROLE_ORDER.map((r) => (
                    <RoleButton
                      active={role === r}
                      key={r}
                      onSelect={setRole}
                      role={r}
                    />
                  ))}
                </div>
              </div>

              {create.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(create.error, "création refusée")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>

            <DialogFooter>
              <Button disabled={create.isPending} type="submit">
                {create.isPending ? <Spinner /> : null}
                Créer
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
