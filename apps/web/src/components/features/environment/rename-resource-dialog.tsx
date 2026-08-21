"use client";

import { renameServiceSchema } from "@noddle/shared/validation/service";
import { TagIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect } from "react";
import type { z } from "zod";

import { useAppForm } from "@/components/fields/lib/form";
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
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { renameDatabase } from "@/server/databases";
import { renameService } from "@/server/services";
import { renameStack } from "@/server/stacks";

export type RenameKind = "database" | "service" | "stack";

/** One intention, three tables. */
function rename(kind: RenameKind, id: string, displayName: string) {
  if (kind === "database") {
    return renameDatabase({ data: { databaseId: id, displayName } });
  }
  if (kind === "stack") {
    return renameStack({ data: { displayName, stackId: id } });
  }
  return renameService({ data: { displayName, serviceId: id } });
}

const formSchema = renameServiceSchema.pick({ displayName: true });

type FormValues = z.infer<typeof formSchema>;

/**
 * Renames what a human reads. The resource's IDENTITY is not on this form.
 *
 * `name` is what the running Swarm service, the volumes and the unique index
 * are derived from, so it is deliberately absent: a field that looked
 * editable here would be the one that silently orphans a deployment. The
 * dialog says so, rather than leaving the omission to be guessed.
 */
export function RenameResourceDialog({
  displayName,
  kind,
  name,
  onOpenChange,
  open,
  resourceId,
}: {
  displayName: string | null;
  kind: RenameKind;
  /** The identity, shown as the fallback so "clear it" has a visible result. */
  name: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  resourceId: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const save = useMutation({
    mutationFn: (value: FormValues) =>
      rename(kind, resourceId, value.displayName),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
      onOpenChange(false);
    },
  });

  const form = useAppForm({
    defaultValues: { displayName: displayName ?? "" } as FormValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: formSchema },
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

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {displayName ?? name}</DialogTitle>
          <DialogDescription>
            Only the label changes. Nothing is redeployed, and the service keeps
            its identity — it still runs as <code>{name}</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <form.AppField name="displayName">
                {(f) => (
                  <f.FieldText
                    addonStart={<TagIcon />}
                    description={`Leave empty to read as ${name} again.`}
                    label="Display name"
                    placeholder={name}
                  />
                )}
              </form.AppField>
              {save.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(save.error, "could not rename")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button disabled={save.isPending} type="submit">
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
