import { generateDatabasePassword } from "@noddle/shared/password";
import { changeDatabasePasswordSchema } from "@noddle/shared/validation/database";
import { ArrowsClockwiseIcon, KeyIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
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
  DialogForm,
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
  const router = useRouter();

  const change = useMutation({
    mutationFn: async (value: ChangePasswordFormValues) => {
      await changeDatabasePassword({
        data: { databaseId, password: value.password },
      });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
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
      form.setFieldValue("password", generateDatabasePassword());
    }
  }, [open, form.reset, form.setFieldValue]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );
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
        <DialogForm onSubmit={handleSubmit}>
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
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button disabled={change.isPending} type="submit">
              {change.isPending ? <Spinner data-icon="inline-start" /> : null}
              Change password
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
