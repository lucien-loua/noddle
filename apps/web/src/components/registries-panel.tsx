import { registrySchema } from "@noddle/shared/validation/registry";
import {
  GlobeIcon,
  KeyIcon,
  PackageIcon,
  TagIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import { useAppForm } from "@/components/fields/lib/form";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldGroup } from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import {
  deleteRegistry,
  getRegistries,
  type RegistryView,
  saveRegistry,
  testRegistry,
} from "@/server/registries";

function RegistryRow({
  canEdit,
  onEdit,
  onRemoved,
  registry,
  role,
}: {
  canEdit: boolean;
  onEdit: (row: RegistryView) => void;
  onRemoved: () => void;
  registry: RegistryView;
  role: RoleName | null;
}) {
  const canDelete = useCan(role, "registry", "delete");
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => deleteRegistry({ data: { id: registry.id } }),
    onError: (e: Error) => setError(errorMessage(e, "removal refused")),
    onSuccess: onRemoved,
  });
  const handleRemove = useCallback(() => remove.mutate(), [remove]);
  const handleEdit = useCallback(() => onEdit(registry), [onEdit, registry]);

  return (
    <TableRow>
      <TableCell className="font-medium">
        {registry.name}
        {error ? (
          <span className="block text-destructive text-xs" role="status">
            {error}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {registry.registryUrl}
        {registry.imagePrefix ? `/${registry.imagePrefix}` : null}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {registry.username}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        <RelativeTime iso={registry.createdAt} />
      </TableCell>
      <TableCell className="text-end">
        <div className="flex justify-end gap-1">
          {canEdit ? (
            <Button onClick={handleEdit} size="sm" variant="ghost">
              Edit
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              disabled={remove.isPending}
              onClick={handleRemove}
              size="sm"
              variant="ghost"
            >
              {remove.isPending ? <Spinner /> : null}
              Remove
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function RegistriesList({
  initial,
  onAdd,
  onEdit,
  role,
}: {
  initial: RegistryView[];
  onAdd?: () => void;
  onEdit: (row: RegistryView) => void;
  role: RoleName | null;
}) {
  const queryClient = useQueryClient();
  const canEdit = useCan(role, "registry", "create");
  const list = useQuery({
    initialData: initial,
    queryFn: () => getRegistries(),
    queryKey: ["registries"],
  });

  const handleRemoved = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["registries"] }),
    [queryClient]
  );

  const rows = list.data ?? initial;
  if (rows.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyMedia>
          <IconStack>
            <PackageIcon className="size-5" weight="duotone" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No external registries</EmptyTitle>
          <EmptyDescription>
            Noddle pushes to its own registry by default. Add one here to push
            somewhere else, such as ghcr.io or a private registry.
          </EmptyDescription>
        </EmptyHeader>
        {onAdd ? (
          <EmptyContent>
            <Button onClick={onAdd}>Add a registry</Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>External registries</FrameTitle>
        <FrameDescription>
          Where Noddle can push the images it builds. Its own registry stays the
          default — these are alternatives, and the password never leaves this
          server.
        </FrameDescription>
      </FrameHeader>
      <FramePanel className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Registry</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Added</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <RegistryRow
                canEdit={canEdit}
                key={row.id}
                onEdit={onEdit}
                onRemoved={handleRemoved}
                registry={row}
                role={role}
              />
            ))}
          </TableBody>
        </Table>
      </FramePanel>
    </Frame>
  );
}

/**
 * What the FORM carries is the schema's INPUT — not its output.
 *
 * `RegistryInput` is a `z.infer`, so the type AFTER parsing: it includes
 * `imagePrefix: string`, because the schema's `.default("")` filled it in.
 * Before parsing, that same field is optional. TanStack Form requires
 * values to match the input of the schema that validates them; conflating
 * the two makes typing fail on exactly that field.
 */
type RegistryFormValues = z.input<typeof registrySchema>;

export function RegistryDialog({
  onOpenChange,
  open,
  target,
}: {
  onOpenChange: (next: boolean) => void;
  open: boolean;
  target: RegistryView | null;
}) {
  const queryClient = useQueryClient();

  /**
   * An EMPTY password means "keep the one that's stored", and only the
   * client knows whether there's something to keep — the shared schema
   * must therefore accept it (it never comes back from the server, the
   * form can't send it back). At CREATION there's nothing to keep: the
   * rule is added here, on top of the common schema, rather than being
   * copied into it.
   */
  const schema = useMemo(
    () =>
      target
        ? registrySchema
        : registrySchema.refine((v) => v.password.length > 0, {
            message: "A password or token is required.",
            path: ["password"],
          }),
    [target]
  );

  // Recomputed on every render, deliberately: `useForm` reapplies its
  // options (as measured — `formApi.update(opts)`), so this is what allows
  // `reset()` below to start over from the CURRENT target.
  const defaultValues: RegistryFormValues = target
    ? {
        id: target.id,
        imagePrefix: target.imagePrefix,
        name: target.name,
        // Never pre-filled: the server doesn't return it, even encrypted.
        password: "",
        registryUrl: target.registryUrl,
        username: target.username,
      }
    : {
        imagePrefix: "",
        name: "",
        password: "",
        registryUrl: "",
        username: "",
      };

  /**
   * "Test" and "Save" go through the SAME submission, distinguished by a
   * piece of metadata — not by two separate validation paths.
   *
   * This is a defect found in practice: the first version validated the
   * test by hand (`validateAllFields` + `validate`). The messages did
   * display, but the form hadn't actually gone through a SUBMISSION — and
   * it's that which switches `revalidateLogic` into "change" mode. Result:
   * after a rejected "Test connection", fixing a field no longer cleared
   * the error, the messages stayed stuck until you clicked "Save". Two
   * doors that show the same errors must leave the form in the same
   * state.
   */
  const form = useAppForm({
    defaultValues,
    onSubmit: ({ meta, value }) =>
      meta.intent === "test"
        ? test.mutateAsync(value)
        : save.mutateAsync(value),
    onSubmitMeta: { intent: "save" } as { intent: "save" | "test" },
    // `onDynamic` and not `onSubmit`: this is the one driven by the base
    // revalidation logic — silent until the first submit, reactive
    // afterward. See `fields/lib/form.ts`.
    validators: { onDynamic: schema },
  });

  // Reopening must start over from the CURRENT target. `defaultValues` is
  // only read at mount, and the dialog stays mounted between two openings —
  // without this, editing a registry after having edited another would
  // reopen the previous one, a defect already paid for on S3 destinations.
  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form]);

  // Testing and saving are two separate actions: we want to be able to
  // verify credentials BEFORE replacing the ones that work.
  const test = useMutation({
    mutationFn: (values: RegistryFormValues) => testRegistry({ data: values }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "the test could not run"),
        title: "Cannot reach the registry",
        type: "error",
      }),
    // `testRegistry` RETURNS the failure instead of throwing: the registry
    // did respond, it's its response that is a rejection.
    onSuccess: (result, values) => {
      if (result.error) {
        toast.add({
          description: result.error,
          title: "Cannot reach the registry",
          type: "error",
        });
        return;
      }
      toast.add({
        description: "The registry accepted these credentials.",
        title: `${values.registryUrl} reachable`,
        type: "success",
      });
    },
  });

  const save = useMutation({
    mutationFn: (values: RegistryFormValues) => saveRegistry({ data: values }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "registry rejected"),
        title: "Not saved",
        type: "error",
      }),
    onSuccess: async (_result, values) => {
      toast.add({
        title: target ? `${values.name} updated` : `${values.name} added`,
        type: "success",
      });
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ["registries"] });
    },
  });

  /**
   * Testing validates first: sending an obviously wrong host would report
   * as "unreachable" something that is only a typo.
   *
   * **A validation failure produces NO toast** — the messages display
   * under the fields concerned, right where they get fixed. A toast would
   * say the same thing somewhere nothing can be done about it, and would
   * obscure the toast's real purpose here: saying that the registry itself
   * said no.
   */
  const handleTest = useCallback(() => {
    form.handleSubmit({ intent: "test" });
  }, [form]);

  // Each button carries ITS OWN pending state: `form.state.isSubmitting`
  // is true for both intents since they share the submission, so it can no
  // longer tell which one is running. Both lock together, but only one
  // shows the spinner.
  const busy = test.isPending || save.isPending;

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit({ intent: "save" });
    },
    [form]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {target ? `Edit ${target.name}` : "Add an external registry"}
          </DialogTitle>
          <DialogDescription>
            Noddle signs in with these credentials to push the images it builds,
            and hands them to Swarm so every node can pull.
          </DialogDescription>
        </DialogHeader>

        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <form.AppField name="name">
                {(f) => (
                  <f.FieldText
                    addonStart={<TagIcon />}
                    description="What you will pick from when deploying a service."
                    label="Name"
                    placeholder="ghcr"
                  />
                )}
              </form.AppField>

              <form.AppField name="registryUrl">
                {(f) => (
                  <f.FieldText
                    addonStart={<GlobeIcon />}
                    description="The hostname only — no https:// and no path. A port is allowed."
                    label="Registry host"
                    placeholder="ghcr.io"
                  />
                )}
              </form.AppField>

              <form.AppField name="username">
                {(f) => (
                  <f.FieldText addonStart={<UserIcon />} label="Username" />
                )}
              </form.AppField>

              <form.AppField name="password">
                {(f) => (
                  <f.FieldPassword
                    addonStart={<KeyIcon />}
                    autoComplete="new-password"
                    description={
                      target ? "Leave empty to keep the stored one." : undefined
                    }
                    label="Password or token"
                    placeholder={target ? "••••••••" : undefined}
                  />
                )}
              </form.AppField>

              <form.AppField name="imagePrefix">
                {(f) => (
                  <f.FieldText
                    addonStart={<PackageIcon />}
                    description="Optional. Sits between the host and the image name, as most registries expect an owner there."
                    label="Image prefix"
                    placeholder="your-org"
                  />
                )}
              </form.AppField>
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
            <Button
              disabled={busy}
              onClick={handleTest}
              type="button"
              variant="outline"
            >
              {test.isPending ? <Spinner /> : null}
              Test connection
            </Button>
            <Button disabled={busy} type="submit">
              {save.isPending ? <Spinner /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
