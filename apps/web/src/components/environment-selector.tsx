import { environmentNameSchema } from "@noddle/shared/validation/project";
import {
  CaretDownIcon,
  CopyIcon,
  PencilSimpleIcon,
  PlusIcon,
  TagIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { MouseEvent, SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import {
  createEnvironment,
  deleteEnvironment,
  duplicateEnvironment,
  type EnvironmentView,
  renameEnvironment,
} from "@/server/environments";

const environmentFormSchema = z.object({
  description: z.string().max(280),
  name: environmentNameSchema,
});

interface EnvironmentFormValues {
  description: string;
  name: string;
}

const duplicateFormSchema = z.object({ name: environmentNameSchema });

interface DuplicateFormValues {
  name: string;
}

type DialogState =
  | { env: EnvironmentView; kind: "delete" }
  | { env: EnvironmentView; kind: "duplicate" }
  | { env: EnvironmentView; kind: "rename" }
  | { kind: "create" }
  | null;

export function EnvironmentSelector({
  counts,
  current,
  environments,
  onNavigate,
  projectId,
  role,
}: {
  /** How many resources (services + stacks + databases) in each
   *  environment — this is what makes an empty environment recognizable at
   *  a glance in the list, not only on its page once opened. */
  counts: Record<string, number>;
  current: EnvironmentView;
  environments: EnvironmentView[];
  onNavigate: (environmentId: string) => void;
  projectId: string;
  role: RoleName | null;
}) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const canWrite = useCan(role, "service", "create");
  const canDelete = useCan(role, "service", "delete");

  const closeDialog = useCallback(() => setDialog(null), []);
  const openCreate = useCallback(() => setDialog({ kind: "create" }), []);
  const handleRowDelete = useCallback(
    (env: EnvironmentView) => setDialog({ env, kind: "delete" }),
    []
  );
  const handleRowDuplicate = useCallback(
    (env: EnvironmentView) => setDialog({ env, kind: "duplicate" }),
    []
  );
  const handleRowRename = useCallback(
    (env: EnvironmentView) => setDialog({ env, kind: "rename" }),
    []
  );
  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeDialog();
      }
    },
    [closeDialog]
  );
  const handleDeleted = useCallback(() => {
    if (dialog?.kind === "delete") {
      onNavigate(current.id === dialog.env.id ? "" : current.id);
    }
  }, [dialog, current.id, onNavigate]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button className="gap-1.5 font-medium" size="sm" variant="ghost">
              <span className="text-muted-foreground">/</span>
              {current.name}
              <CaretDownIcon
                className="text-muted-foreground"
                data-icon="inline-end"
              />
            </Button>
          }
        />
        <DropdownMenuContent align="center">
          {environments.map((env) => (
            <EnvironmentRow
              canDelete={canDelete}
              canWrite={canWrite}
              count={counts[env.id] ?? 0}
              current={env.id === current.id}
              env={env}
              key={env.id}
              onDelete={handleRowDelete}
              onDuplicate={handleRowDuplicate}
              onNavigate={onNavigate}
              onRename={handleRowRename}
            />
          ))}
          {canWrite ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openCreate}>
                <PlusIcon />
                New environment
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateEnvironmentDialog
        onCreated={onNavigate}
        onOpenChange={handleDialogOpenChange}
        open={dialog?.kind === "create"}
        projectId={projectId}
      />
      {dialog?.kind === "rename" ? (
        <RenameEnvironmentDialog
          env={dialog.env}
          onOpenChange={handleDialogOpenChange}
          open
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteEnvironmentDialog
          env={dialog.env}
          onDeleted={handleDeleted}
          onOpenChange={handleDialogOpenChange}
          open
        />
      ) : null}
      {dialog?.kind === "duplicate" ? (
        <DuplicateEnvironmentDialog
          env={dialog.env}
          onDuplicated={onNavigate}
          onOpenChange={handleDialogOpenChange}
          open
        />
      ) : null}
    </>
  );
}

function EnvironmentRow({
  canDelete,
  canWrite,
  count,
  current,
  env,
  onDelete,
  onDuplicate,
  onNavigate,
  onRename,
}: {
  canDelete: boolean;
  canWrite: boolean;
  count: number;
  current: boolean;
  env: EnvironmentView;
  onDelete: (env: EnvironmentView) => void;
  onDuplicate: (env: EnvironmentView) => void;
  onNavigate: (environmentId: string) => void;
  onRename: (env: EnvironmentView) => void;
}) {
  const handleSelect = useCallback(
    () => onNavigate(env.id),
    [env.id, onNavigate]
  );
  const handleRename = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onRename(env);
    },
    [env, onRename]
  );
  const handleDuplicate = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onDuplicate(env);
    },
    [env, onDuplicate]
  );
  const handleDelete = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onDelete(env);
    },
    [env, onDelete]
  );

  return (
    <DropdownMenuItem className="justify-between gap-2" onClick={handleSelect}>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={
            current
              ? "size-1.5 shrink-0 rounded-full bg-primary"
              : "size-1.5 shrink-0"
          }
        />
        <span className="truncate">{env.name}</span>
        <span className="text-muted-foreground text-xs">({count})</span>
      </span>
      {canWrite ? (
        // `w-0` in addition to `opacity-0`: opacity alone hides them but
        // KEEPS their width, so the environment name was permanently
        // truncated to make room for three buttons you couldn't see. They
        // only take space on hover.
        //
        // `focus-within` as well as `group-hover`: without it, the buttons
        // would stay at zero width under keyboard navigation — reachable
        // via Tab, so focused, but invisible and with no clickable surface.
        <span className="flex w-0 shrink-0 items-center gap-0.5 overflow-hidden opacity-0 transition-[width,opacity] focus-within:w-auto focus-within:opacity-100 group-hover/dropdown-menu-item:w-auto group-hover/dropdown-menu-item:opacity-100">
          <Button
            aria-label={`Duplicate ${env.name}`}
            className="size-6"
            onClick={handleDuplicate}
            size="icon"
            variant="ghost"
          >
            <CopyIcon />
          </Button>
          {env.isDefault ? null : (
            <>
              <Button
                aria-label={`Rename ${env.name}`}
                className="size-6"
                onClick={handleRename}
                size="icon"
                variant="ghost"
              >
                <PencilSimpleIcon />
              </Button>
              {canDelete ? (
                <Button
                  aria-label={`Delete ${env.name}`}
                  className="size-6"
                  onClick={handleDelete}
                  size="icon"
                  variant="ghost"
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          )}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

function CreateEnvironmentDialog({
  onCreated,
  onOpenChange,
  open,
  projectId,
}: {
  onCreated: (environmentId: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const create = useMutation({
    mutationFn: (value: EnvironmentFormValues) =>
      createEnvironment({
        data: {
          description: value.description || undefined,
          name: value.name,
          projectId,
        },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      await router.invalidate();
      onOpenChange(false);
      onCreated(result.environmentId);
    },
  });

  const form = useAppForm({
    defaultValues: { description: "", name: "" } as EnvironmentFormValues,
    onSubmit: ({ value }) => create.mutateAsync(value),
    validators: { onDynamic: environmentFormSchema },
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
          <DialogTitle>New environment</DialogTitle>
          <DialogDescription>
            A place to connect services, stacks and databases to — e.g. staging,
            next to production.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <form.AppField name="name">
                {(f) => (
                  <f.FieldText
                    addonStart={<TagIcon />}
                    label="Name"
                    placeholder="staging"
                    required
                  />
                )}
              </form.AppField>
              <form.AppField name="description">
                {(f) => <f.FieldTextarea label="Description (optional)" />}
              </form.AppField>
              {create.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(create.error, "could not create")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button disabled={create.isPending} type="submit">
              {create.isPending ? <Spinner data-icon="inline-start" /> : null}
              Create environment
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function RenameEnvironmentDialog({
  env,
  onOpenChange,
  open,
}: {
  env: EnvironmentView;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const rename = useMutation({
    mutationFn: (value: EnvironmentFormValues) =>
      renameEnvironment({
        data: {
          description: value.description || undefined,
          environmentId: env.id,
          name: value.name,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      // Stay on the SAME page — the name shown in the selector trigger
      // comes from the loader, not a `useQuery`: without this it would keep
      // showing the old name until a manual reload.
      await router.invalidate();
      onOpenChange(false);
    },
  });

  const form = useAppForm({
    defaultValues: {
      description: env.description ?? "",
      name: env.name,
    } as EnvironmentFormValues,
    onSubmit: ({ value }) => rename.mutateAsync(value),
    validators: { onDynamic: environmentFormSchema },
  });

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
          <DialogTitle>Rename {env.name}</DialogTitle>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <form.AppField name="name">
                {(f) => (
                  <f.FieldText addonStart={<TagIcon />} label="Name" required />
                )}
              </form.AppField>
              <form.AppField name="description">
                {(f) => <f.FieldTextarea label="Description (optional)" />}
              </form.AppField>
              {rename.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(rename.error, "could not rename")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button disabled={rename.isPending} type="submit">
              {rename.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function DeleteEnvironmentDialog({
  env,
  onDeleted,
  onOpenChange,
  open,
}: {
  env: EnvironmentView;
  onDeleted: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => deleteEnvironment({ data: { environmentId: env.id } }),
    onError: (e: Error) => setError(errorMessage(e, "could not delete")),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      // `onDeleted` may navigate to the environment ALREADY on screen
      // (unchanged id) if we deleted a neighbouring one: in that case the
      // router does not re-run its loader on its own.
      await router.invalidate();
      onOpenChange(false);
      onDeleted();
    },
  });

  const handleConfirm = useCallback(() => remove.mutate(), [remove]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {env.name}?</DialogTitle>
          <DialogDescription>
            Only possible while it is empty — remove its services, stacks and
            databases first.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            disabled={remove.isPending}
            onClick={handleConfirm}
            variant="destructive"
          >
            {remove.isPending ? <Spinner data-icon="inline-start" /> : null}
            Delete environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateEnvironmentDialog({
  env,
  onDuplicated,
  onOpenChange,
  open,
}: {
  env: EnvironmentView;
  onDuplicated: (environmentId: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const duplicate = useMutation({
    mutationFn: (value: DuplicateFormValues) =>
      duplicateEnvironment({
        data: { environmentId: env.id, name: value.name },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      await router.invalidate();
      onOpenChange(false);
      if (result.databasesSkipped > 0) {
        toast.add({
          description: `${result.databasesSkipped} database${result.databasesSkipped === 1 ? "" : "s"} skipped — attach a fresh one and copy the data manually if you need it there.`,
          title: "Databases were not duplicated",
          type: "info",
        });
      }
      onDuplicated(result.environmentId);
    },
  });

  const form = useAppForm({
    defaultValues: { name: `${env.name}-copy` } as DuplicateFormValues,
    onSubmit: ({ value }) => duplicate.mutateAsync(value),
    validators: { onDynamic: duplicateFormSchema },
  });

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
          <DialogTitle>Duplicate {env.name}</DialogTitle>
          <DialogDescription>
            Copies services and stacks — configuration and environment
            variables, not their running data. Domains are left unset so the
            copy never fights the original for the same route. Databases are NOT
            duplicated: they hold real data on a real volume, and a config-only
            clone would only look like a copy.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <form.AppField name="name">
                {(f) => (
                  <f.FieldText
                    addonStart={<TagIcon />}
                    label="New environment name"
                    required
                  />
                )}
              </form.AppField>
              {duplicate.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(duplicate.error, "could not duplicate")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button disabled={duplicate.isPending} type="submit">
              {duplicate.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              Duplicate
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
