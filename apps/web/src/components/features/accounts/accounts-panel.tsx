import { createAccountSchema } from "@noddle/shared/validation/account";
import { EnvelopeIcon, UserIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { RevealOnce } from "@/components/features/settings-list/reveal-once";
import { SettingsList } from "@/components/features/settings-list/settings-list";
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
  roles,
} from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import {
  createAccount,
  removeAccount,
  setAccountRole,
} from "@/server/accounts";
import type { AccountRow } from "@/server/accounts";

export function AccountsPanel({
  initial,
  onOpenChange,
  open,
  role,
}: {
  initial: AccountRow[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  role: string | null;
}) {
  const known = role && role in roles ? (role as RoleName) : null;
  const canCreate = useCan(known, "user", "create");
  const { data: accounts, refresh } = useResourceList(
    queries.accounts,
    initial
  );

  return (
    <div className="space-y-4">
      <CreateAccountDialog
        onDone={refresh}
        onOpenChange={onOpenChange}
        open={open}
      />

      <SettingsList isEmpty={false}>
        <SettingsList.Frame
          description="A role decides what an account can do, never what it can see: everyone reads the same dashboard."
          title="Accounts"
        >
          <Table>
            <TableHeader>
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
              {accounts.map((account) => (
                <AccountLine
                  account={account}
                  canManage={canCreate}
                  key={account.id}
                  onDone={refresh}
                />
              ))}
            </TableBody>
          </Table>
        </SettingsList.Frame>
      </SettingsList>
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
        {error ? (
          <output className="mt-1 block whitespace-normal text-destructive text-xs">
            {error}
          </output>
        ) : null}
      </TableCell>

      <TableCell className="hidden text-muted-foreground text-xs sm:table-cell">
        <RelativeTime iso={account.createdAt} />
      </TableCell>

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

function roleLabel(role: string): string {
  return role in ROLE_LABELS ? ROLE_LABELS[role as RoleName] : role;
}

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

function PasswordReveal({ password }: { password: string }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Account created</DialogTitle>
        <DialogDescription>
          Here is its password. It is shown once and can never be read again.
          Hand it over now.
        </DialogDescription>
      </DialogHeader>

      <RevealOnce label="password" value={password} />

      <DialogFooter>
        <DialogClose render={<Button>Done</Button>} />
      </DialogFooter>
    </>
  );
}
