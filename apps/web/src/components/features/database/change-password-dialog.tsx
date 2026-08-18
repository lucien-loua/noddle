import { generateDatabasePassword } from "@noddle/shared/password";
import { changeDatabasePasswordSchema } from "@noddle/shared/validation/database";
import { ArrowsClockwiseIcon, KeyIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { useAppForm } from "@/components/fields/lib/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { InputGroupButton } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import {
  changeDatabasePassword,
  getDatabaseCredentials,
} from "@/server/databases";

const changePasswordFormSchema = changeDatabasePasswordSchema.pick({
  password: true,
});

interface ChangePasswordFormValues {
  password: string;
}

export function ChangeDatabasePasswordDialog({
  databaseId,
  databaseName,
  onOpenChange,
  open,
}: {
  databaseId: string;
  databaseName: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  // The record comes from a route LOADER: `invalidateQueries` alone doesn't
  // refresh it.
  const router = useRouter();

  const change = useMutation({
    mutationFn: async (value: ChangePasswordFormValues) => {
      await changeDatabasePassword({
        data: { databaseId, password: value.password },
      });
      // The server function returns control as soon as it's QUEUED: the
      // worker hasn't done anything yet. Closing here used to refresh the
      // "credentials" block BEFORE the change, and the screen would then
      // show the OLD password under a dialog that had just announced the
      // new one — measured in the browser. Someone would have copied it and
      // it wouldn't have worked.
      //
      // So we wait for the DATABASE to carry the new value. `getDatabase-
      // Credentials` requires `envVar: read`, but that's already the guard
      // on the block this button is opened from: there's no case where you
      // can trigger it without being able to read it back.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        // biome-ignore lint/performance/noAwaitInLoops: polling, one request after another
        await new Promise((resolve) => {
          setTimeout(resolve, 1500);
        });
        const current = await getDatabaseCredentials({ data: { databaseId } });
        if (current.password === value.password) {
          return;
        }
      }
      throw new Error(
        "still applying: the engine has not confirmed the new password yet"
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
      onOpenChange(false);
    },
  });

  const form = useAppForm({
    defaultValues: {
      password: generateDatabasePassword(),
    } as ChangePasswordFormValues,
    onSubmit: ({ value }) => change.mutateAsync(value),
    validators: { onDynamic: changePasswordFormSchema },
  });

  useEffect(() => {
    if (open) {
      form.reset();
      // A FRESH password on every open: keeping the previous one would
      // leave it sitting in browser memory after an abandoned attempt, and
      // could let it be inadvertently replayed.
      form.setFieldValue("password", generateDatabasePassword());
    }
  }, [open, form.reset, form.setFieldValue]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);
  const regenerate = useCallback(
    () => form.setFieldValue("password", generateDatabasePassword()),
    [form]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Applied to the running {databaseName} engine right away, then stored
            for Noddle to use.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FieldGroup>
            <form.AppField name="password">
              {(f) => (
                <f.FieldPassword
                  addonEnd={
                    <InputGroupButton
                      aria-label="Generate a new password"
                      onClick={regenerate}
                      size="icon-xs"
                    >
                      <ArrowsClockwiseIcon weight="regular" />
                    </InputGroupButton>
                  }
                  addonStart={<KeyIcon />}
                  label="New password"
                  required
                />
              )}
            </form.AppField>

            <Alert>
              <AlertDescription>
                Services already attached to this database keep the old
                connection string. Re-attach them, or update their environment
                variables, or they will stop connecting.
              </AlertDescription>
            </Alert>

            {change.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {errorMessage(change.error, "could not change")}
                </AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </DialogBody>
        <DialogFooter>
          {/* NO `nativeButton={false}`: that escape hatch declares "what I
              render isn't a <button>", so it's meant for a LINK dressed up
              as a button. `Button` is a real one, and claiming otherwise
              makes Base UI throw in the console. */}
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button disabled={change.isPending} onClick={handleSubmit}>
            {change.isPending ? <Spinner data-icon="inline-start" /> : null}
            Change password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
