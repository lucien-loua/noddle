// Les comptes de l'installation.
//
// Le mot de passe d'un compte créé s'affiche UNE SEULE FOIS — même règle que
// le secret d'un webhook : il doit sortir vers un tiers, donc il se montre à
// sa génération et n'est jamais relu. Contrairement au mot de passe d'une base
// de données, qui n'a aucun tiers à qui être donné et ne sort donc jamais.
//
// **Un rôle se choisit en sachant ce qu'il ouvre.** C'est ce qui dicte la
// forme de cet écran : les rôles ne sont pas quatre boutons qu'on distingue à
// la nuance de leur fond, mais un groupe de radios où chaque option porte la
// phrase qui dit ce qu'elle accorde. Accorder « Administrateur » en croyant
// accorder « Opérateur » est la seule faute vraiment coûteuse ici.
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/lib/format";
import {
  ROLE_DESCRIPTIONS,
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
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Un rôle décide de ce qu'un compte peut faire, jamais de ce qu'il peut
          voir : tout le monde lit le même tableau de bord.
        </p>
        {canCreate ? (
          <Button className="shrink-0" onClick={handleOpen} size="sm">
            Créer un compte
          </Button>
        ) : null}
      </div>

      <CreateAccountDialog
        onDone={refresh}
        onOpenChange={setOpen}
        open={open}
      />

      {/* Un vrai tableau, comme l'historique des sauvegardes et celui des
          déploiements : les comptes sont des données tabulaires homogènes, et
          l'en-tête donne au sélecteur de rôle le libellé VISIBLE qu'un
          `aria-label` seul ne fournit qu'aux lecteurs d'écran. */}
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            {/* Seule la colonne Compte est laissée sans largeur : elle
                absorbe l'espace qui reste, et Créé/Rôle/l'action se tassent
                ensemble à droite plutôt que de se répartir sur toute la
                ligne — un tableau de deux comptes n'a pas besoin d'étaler ses
                quatre colonnes jusqu'au bord. */}
            <TableRow className="hover:bg-transparent">
              <TableHead>Compte</TableHead>
              <TableHead className="hidden w-32 sm:table-cell">Créé</TableHead>
              <TableHead className="w-44">Rôle</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(accounts.data ?? []).map((account) => (
              <AccountLine
                account={account}
                canManage={canCreate}
                key={account.id}
                onDone={refresh}
              />
            ))}
          </TableBody>
        </Table>
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
    <TableRow>
      <TableCell className="max-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{account.name}</span>
          {account.isSelf ? <Badge variant="outline">vous</Badge> : null}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {account.email}
        </span>
        {/* L'échec s'affiche SUR la ligne concernée, pas dans une bannière en
            haut : « ce compte est le dernier propriétaire » ne veut rien dire
            si on ne voit pas duquel il s'agit. */}
        {error ? (
          <span className="mt-1 block whitespace-normal text-destructive text-xs">
            {errorMessage(error, "action refusée")}
          </span>
        ) : null}
      </TableCell>

      <TableCell className="hidden text-muted-foreground text-xs sm:table-cell">
        <RelativeTime iso={account.createdAt} />
      </TableCell>

      {/* Le rôle est affiché dans les DEUX cas. Auparavant il n'apparaissait
          qu'à qui pouvait le changer, donc un lecteur ne pouvait pas savoir
          qui était administrateur — une information qui se lit sans rien
          pouvoir en faire. */}
      <TableCell>
        {canManage ? (
          <RoleSelect
            onChange={setRole.mutate}
            pending={setRole.isPending}
            value={account.role}
          />
        ) : (
          <Badge variant="outline">{roleLabel(account.role)}</Badge>
        )}
      </TableCell>

      {/* Se supprimer soi-même est refusé côté serveur ; le bouton disparaît
          pour que l'interface ne propose pas ce qu'elle sait impossible. */}
      <TableCell className="text-end">
        {account.isSelf || !canManage ? null : (
          <Button
            disabled={remove.isPending}
            onClick={handleRemove}
            size="sm"
            variant="ghost"
          >
            {remove.isPending ? <Spinner /> : null}
            Retirer
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Le rôle stocké est un `string` : on n'invente pas de libellé pour une
 *  valeur qu'on ne connaît pas, on la montre telle quelle. */
function roleLabel(role: string): string {
  return role in ROLE_LABELS ? ROLE_LABELS[role as RoleName] : role;
}

/**
 * Changer le rôle d'un compte existant.
 *
 * Une liste déroulante, pas quatre boutons : dans une ligne de tableau, le
 * rôle COURANT doit se lire sans comparer les fonds de quatre boutons entre
 * eux. Le déclencheur porte la valeur, les options portent ce qu'elles
 * accordent.
 */
function RoleSelect({
  onChange,
  pending,
  value,
}: {
  onChange: (role: RoleName) => void;
  pending: boolean;
  value: string;
}) {
  const handleChange = useCallback(
    (next: unknown) => {
      if (typeof next === "string" && next in ROLE_LABELS) {
        onChange(next as RoleName);
      }
    },
    [onChange]
  );

  return (
    // `items` : sans lui, Base UI affiche la VALEUR stockée. Le déclencheur
    // annonçait « owner » et « viewer » au lieu de « Propriétaire » et
    // « Lecteur » — le jargon de la base remonté jusqu'à l'écran.
    <Select
      disabled={pending}
      items={ROLE_LABELS}
      onValueChange={handleChange}
      value={value}
    >
      <SelectTrigger aria-label="Rôle" className="w-40" size="sm">
        {pending ? <Spinner /> : null}
        <SelectValue />
      </SelectTrigger>
      {/* `alignItemWithTrigger={false}` : sinon le panneau se cale sur
          l'option choisie ET prend la largeur du déclencheur, ce qui écrase
          les descriptions sur quatre lignes chacune. */}
      <SelectContent
        alignItemWithTrigger={false}
        className="w-80"
        side="bottom"
      >
        <SelectGroup>
          {ROLE_ORDER.map((role) => (
            <SelectItem key={role} value={role}>
              <span className="flex flex-col gap-0.5 whitespace-normal">
                <span>{ROLE_LABELS[role]}</span>
                <span className="font-normal text-muted-foreground text-xs">
                  {ROLE_DESCRIPTIONS[role]}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
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
      setRole("viewer");
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
  const handleRole = useCallback((next: unknown) => {
    if (typeof next === "string" && next in ROLE_LABELS) {
      setRole(next as RoleName);
    }
  }, []);
  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) {
        // Le mot de passe part avec la boîte : le relire est impossible, et
        // le laisser à l'écran donnerait l'illusion qu'on peut y revenir.
        setPassword(null);
        create.reset();
      }
      onOpenChange(next);
    },
    [create, onOpenChange]
  );

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent>
        {password ? (
          <PasswordReveal password={password} />
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Créer un compte</DialogTitle>
              <DialogDescription>
                Le mot de passe est généré par Noddle et affiché une seule fois.
              </DialogDescription>
            </DialogHeader>

            <FieldGroup className="gap-5 py-5">
              <Field>
                <FieldLabel htmlFor="accountName">Nom</FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={create.isPending}
                  id="accountName"
                  onChange={handleName}
                  required
                  value={name}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="accountEmail">Adresse e-mail</FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={create.isPending}
                  id="accountEmail"
                  onChange={handleEmail}
                  required
                  type="email"
                  value={email}
                />
              </Field>

              {/* Un vrai groupe de radios : une seule tabulation, les flèches
                  parcourent les options, et l'option cochée s'annonce comme
                  telle. Quatre boutons ne disaient rien de tout ça — ni
                  lequel était choisi, ni qu'ils s'excluaient. */}
              <FieldSet disabled={create.isPending}>
                <FieldLegend variant="label">Rôle</FieldLegend>
                <RadioGroup onValueChange={handleRole} value={role}>
                  {ROLE_ORDER.map((option) => (
                    <FieldLabel htmlFor={`role-${option}`} key={option}>
                      <Field orientation="horizontal">
                        <RadioGroupItem id={`role-${option}`} value={option} />
                        <FieldContent>
                          <FieldTitle>{ROLE_LABELS[option]}</FieldTitle>
                          <FieldDescription>
                            {ROLE_DESCRIPTIONS[option]}
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </FieldSet>

              {create.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(create.error, "création refusée")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>

            <DialogFooter>
              <DialogClose
                render={
                  <Button type="button" variant="outline">
                    Annuler
                  </Button>
                }
              />
              <Button disabled={create.isPending} type="submit">
                {create.isPending ? <Spinner /> : null}
                Créer le compte
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Le mot de passe, montré une fois.
 *
 * Avec un bouton pour le copier, et ce n'est pas du confort : trente-deux
 * caractères hexadécimaux sélectionnés à la souris se tronquent, et il n'y a
 * pas de seconde chance pour s'en apercevoir. Le seul moyen de refermer est
 * explicite — « Terminé » — plutôt que la croix, parce que fermer signifie
 * ici « je l'ai transmis », pas « j'abandonne ».
 */
function PasswordReveal({ password }: { password: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(password);
    setCopied(true);
  }, [password]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Compte créé</DialogTitle>
        <DialogDescription>
          Voici son mot de passe. Il n'est affiché qu'une fois et ne peut pas
          être relu — transmettez-le maintenant.
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-2 rounded-xl bg-muted p-2">
        <code className="min-w-0 flex-1 break-all px-1 font-mono text-sm">
          {password}
        </code>
        <Button
          aria-label="Copier le mot de passe"
          className="shrink-0"
          onClick={handleCopy}
          size="icon-sm"
          variant="outline"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      {/* `aria-live` : la coche seule ne dit rien à qui ne la voit pas, et
          c'est justement l'action dont on veut la confirmation. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Mot de passe copié" : ""}
      </span>

      <DialogFooter>
        <DialogClose render={<Button>Terminé</Button>} />
      </DialogFooter>
    </>
  );
}
