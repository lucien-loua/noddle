import { createAccountSchema } from "@noddle/shared/validation/account";
import { EnvelopeIcon, UserIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { CopyableValue } from "@/components/copyable-value";
import { useAppForm } from "@/components/fields/lib/form";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
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
import { queryKeys } from "@/lib/query-keys";
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
  onOpenChange,
  open,
  role,
}: {
  initial: AccountRow[];
  /** The dialog's state lives in the ROUTE: its open button is mounted in
   *  the AppShell's header, not here. */
  onOpenChange: (open: boolean) => void;
  open: boolean;
  role: string | null;
}) {
  // The session yields a `string`: we check it against known roles here,
  // once, rather than casting it on every call.
  const known = role && role in roles ? (role as RoleName) : null;
  // A courtesy, not security: the server refuses it anyway. Not offering a
  // forbidden action mainly avoids leading someone to click into an error
  // message.
  const canCreate = useCan(known, "user", "create");
  const queryClient = useQueryClient();

  const accounts = useQuery({
    initialData: initial,
    queryFn: () => getAccounts(),
    queryKey: queryKeys.accounts(),
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.accounts() }),
    [queryClient]
  );

  return (
    <div className="space-y-4">
      <CreateAccountDialog
        onDone={refresh}
        onOpenChange={onOpenChange}
        open={open}
      />

      {/* A real table, like the backup history and the deployment history:
          accounts are homogeneous tabular data, and the header gives the
          role selector the VISIBLE label that an `aria-label` alone only
          provides to screen readers.

          `Frame`/`FramePanel` rather than a hand-rolled frame: the same
          pattern as the Containers page, a preset panel rather than a
          `border rounded-2xl` rewritten line by line. */}
      <Frame variant="ghost">
        <FrameHeader>
          <FrameTitle>Accounts</FrameTitle>
          <FrameDescription>
            A role decides what an account can do, never what it can see —
            everyone reads the same dashboard.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="p-0">
          <Table>
            <TableHeader>
              {/* Only the Account column is left without a width: it
                absorbs the remaining space, and Created/Role/the action
                huddle together on the right instead of spreading across the
                whole row — a table of two accounts doesn't need its four
                columns stretched to the edge. */}
              <TableRow className="hover:bg-transparent">
                <TableHead>Account</TableHead>
                <TableHead className="hidden w-32 sm:table-cell">
                  Created
                </TableHead>
                <TableHead className="w-44">Role</TableHead>
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
        </FramePanel>
      </Frame>
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

  // Removal carries its own message rather than an `Error`: it now lives in
  // a child component, which already surfaces the formatted text.
  const [removeError, setRemoveError] = useState<string | null>(null);
  const error = setRole.error
    ? errorMessage(setRole.error, "action refused")
    : removeError;

  return (
    <TableRow>
      <TableCell className="max-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{account.name}</span>
          {account.isSelf ? <Badge variant="outline">you</Badge> : null}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {account.email}
        </span>
        {/* The failure is shown ON the row it concerns, not in a banner at
            the top: "this account is the last owner" means nothing if you
            can't see which one it is. */}
        {error ? (
          <span
            className="mt-1 block whitespace-normal text-destructive text-xs"
            role="status"
          >
            {error}
          </span>
        ) : null}
      </TableCell>

      <TableCell className="hidden text-muted-foreground text-xs sm:table-cell">
        <RelativeTime iso={account.createdAt} />
      </TableCell>

      {/* The role is shown in BOTH cases. It used to appear only to whoever
          could change it, so a viewer had no way to know who was an admin —
          information you can read without being able to act on it. */}
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

      {/* Removing yourself is refused server-side; the button disappears so
          the interface doesn't offer what it knows is impossible. */}
      <TableCell className="text-end">
        {account.isSelf || !canManage ? null : (
          <RemoveAccountAction
            account={account}
            onDone={onDone}
            onError={setRemoveError}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Removing an account: the button, the confirmation, and the mutation
 * together.
 *
 * Same shape as `DeleteServiceAction`, and for the same reason: the
 * retyped address goes to the SERVER, which re-checks it. This component
 * isn't the safeguard, it's the courtesy of one.
 *
 * This used to be the only destructive action in the product that fired on
 * the FIRST click, with nothing retyped — a discrete button in a table row,
 * next to a role selector that gets used routinely.
 *
 * The refusal is surfaced on the ROW instead of shown here: "this account
 * is the last owner" means nothing if you can't see which one it is, and
 * the dialog is already closed by the time the message arrives.
 */
function RemoveAccountAction({
  account,
  onDone,
  onError,
}: {
  account: AccountRow;
  onDone: () => void;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (confirmEmail: string) =>
      removeAccount({ data: { confirmEmail, userId: account.id } }),
    onError: (e: Error) => {
      setOpen(false);
      onError(errorMessage(e, "removal refused"));
    },
    onSuccess: onDone,
  });

  const handleOpen = useCallback(() => {
    onError(null);
    setOpen(true);
  }, [onError]);
  const handleConfirm = useCallback(
    (typed: string) => remove.mutate(typed),
    [remove]
  );

  return (
    <>
      <Button onClick={handleOpen} size="sm" variant="ghost">
        Remove
      </Button>

      {/* State what leaves and what stays. The surviving audit log is
          exactly what you want to know at this moment: removing someone
          doesn't erase the trace of what they did. */}
      <ConfirmNameDialog
        confirmLabel="Remove account"
        description={
          <>
            This account loses access immediately and its sessions are revoked.
            What it did stays in the audit log.{" "}
            <strong>This cannot be undone.</strong>
          </>
        }
        onConfirm={handleConfirm}
        onOpenChange={setOpen}
        open={open}
        pending={remove.isPending}
        resourceName={account.email}
        title={`Remove ${account.name}?`}
      />
    </>
  );
}

/** The stored role is a `string`: we don't invent a label for a value we
 *  don't know, we show it as-is. */
function roleLabel(role: string): string {
  return role in ROLE_LABELS ? ROLE_LABELS[role as RoleName] : role;
}

/**
 * Changing an existing account's role.
 *
 * A dropdown, not four buttons: in a table row, the CURRENT role must be
 * readable without comparing the backgrounds of four buttons against each
 * other. The trigger carries the value, the options carry what they grant.
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
    // `items`: without it, Base UI displays the STORED value. The trigger
    // used to announce "owner" and "viewer" instead of their labels — the
    // database's jargon leaking up to the screen.
    <Select
      disabled={pending}
      items={ROLE_LABELS}
      onValueChange={handleChange}
      value={value}
    >
      <SelectTrigger aria-label="Role" className="w-40" size="sm">
        {pending ? <Spinner /> : null}
        <SelectValue />
      </SelectTrigger>
      {/* `alignItemWithTrigger={false}`: otherwise the panel aligns itself
          on the chosen option AND takes the trigger's width, which crushes
          the descriptions into four lines each. */}
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

interface CreateAccountFormValues {
  email: string;
  name: string;
  role: RoleName;
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
  const [password, setPassword] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (value: CreateAccountFormValues) =>
      createAccount({
        data: { email: value.email, name: value.name, role: value.role },
      }),
    onSuccess: (result) => {
      setPassword(result.password);
      onDone();
    },
  });

  const form = useAppForm({
    defaultValues: {
      email: "",
      name: "",
      role: "viewer",
    } as CreateAccountFormValues,
    onSubmit: ({ value }) => create.mutateAsync(value),
    validators: { onDynamic: createAccountSchema },
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form.reset]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );
  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) {
        // The password leaves with the dialog: reading it again is
        // impossible, and leaving it on screen would give the illusion
        // that you can come back to it.
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
          <>
            <DialogHeader>
              <DialogTitle>New account</DialogTitle>
              <DialogDescription>
                The password is generated by Noddle and shown only once.
              </DialogDescription>
            </DialogHeader>

            <DialogForm onSubmit={handleSubmit}>
              <DialogBody>
                <FieldGroup>
                  <form.AppField name="name">
                    {(f) => (
                      <f.FieldText
                        addonStart={<UserIcon />}
                        autoComplete="off"
                        disabled={create.isPending}
                        label="Name"
                        required
                      />
                    )}
                  </form.AppField>

                  <form.AppField name="email">
                    {(f) => (
                      <f.FieldText
                        addonStart={<EnvelopeIcon />}
                        autoComplete="off"
                        disabled={create.isPending}
                        label="Email address"
                        required
                        type="email"
                      />
                    )}
                  </form.AppField>

                  {/* The role is a FIXED list of four entries where each
                      option carries the sentence that says what it grants:
                      exactly what `FieldSelect` serves — the label on the
                      trigger, the description under the label in the menu. */}
                  <form.AppField name="role">
                    {(f) => (
                      <f.FieldSelect
                        disabled={create.isPending}
                        label="Role"
                        options={ROLE_ORDER.map((option) => ({
                          description: ROLE_DESCRIPTIONS[option],
                          label: ROLE_LABELS[option],
                          value: option,
                        }))}
                      />
                    )}
                  </form.AppField>

                  {create.isError ? (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {errorMessage(create.error, "creation refused")}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </FieldGroup>
              </DialogBody>

              <DialogFooter>
                <DialogClose
                  render={
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  }
                />
                <Button disabled={create.isPending} type="submit">
                  {create.isPending ? <Spinner /> : null}
                  Create account
                </Button>
              </DialogFooter>
            </DialogForm>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The password, shown once.
 *
 * With a button to copy it, and that's not a comfort feature: thirty-two
 * hexadecimal characters selected with the mouse get truncated, and there's
 * no second chance to notice. The only way to close is explicit —
 * "Done" — rather than the close icon, because closing here means "I've
 * handed it over", not "I'm giving up".
 */
function PasswordReveal({ password }: { password: string }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Account created</DialogTitle>
        <DialogDescription>
          Here is its password. It is shown once and can never be read again —
          hand it over now.
        </DialogDescription>
      </DialogHeader>

      <CopyableValue label="password" value={password} />

      <DialogFooter>
        <DialogClose render={<Button>Done</Button>} />
      </DialogFooter>
    </>
  );
}
