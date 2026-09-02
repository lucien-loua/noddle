import { projectNameSchema } from "@noddle/shared/validation/project";
import {
  DotsThreeIcon,
  FolderIcon,
  PencilSimpleIcon,
  TagIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
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
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { createProject, deleteProject, renameProject } from "@/server/projects";

export function CreateProjectButton({ role }: { role: RoleName | null }) {
  const [open, setOpen] = useState(false);
  const canCreate = useCan(role, "service", "create");
  const handleOpen = useCallback(() => setOpen(true), []);

  if (!canCreate) {
    return null;
  }

  return (
    <>
      <Button onClick={handleOpen}>
        <FolderIcon data-icon="inline-start" weight="regular" />
        Create Project
      </Button>
      <ProjectFormDialog onOpenChange={setOpen} open={open} />
    </>
  );
}

export function ProjectRowActions({
  description,
  name,
  projectId,
  role,
}: {
  description: string | null;
  name: string;
  projectId: string;
  role: RoleName | null;
}) {
  const [dialog, setDialog] = useState<"delete" | "rename" | null>(null);
  const canWrite = useCan(role, "service", "create");
  const canDelete = useCan(role, "service", "delete");

  const openRename = useCallback(() => setDialog("rename"), []);
  const openDelete = useCallback(() => setDialog("delete"), []);
  const close = useCallback((next: boolean) => {
    if (!next) {
      setDialog(null);
    }
  }, []);

  if (!(canWrite || canDelete)) {
    return null;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={`Actions for ${name}`}
              size="icon-xs"
              variant="ghost"
            >
              <DotsThreeIcon weight="regular" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {canWrite ? (
            <DropdownMenuItem onClick={openRename}>
              <PencilSimpleIcon />
              Rename
            </DropdownMenuItem>
          ) : null}
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openDelete} variant="destructive">
                <TrashIcon />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "rename" ? (
        <ProjectFormDialog
          existing={{ description, name, projectId }}
          onOpenChange={close}
          open
        />
      ) : null}
      {dialog === "delete" ? (
        <DeleteProjectDialog
          name={name}
          onOpenChange={close}
          open
          projectId={projectId}
        />
      ) : null}
    </>
  );
}

const projectFormSchema = z.object({
  description: z
    .string()
    .max(280, "Keep the description under 280 characters."),
  name: projectNameSchema,
});

interface ProjectFormValues {
  description: string;
  name: string;
}

function ProjectFormDialog({
  existing,
  onOpenChange,
  open,
}: {
  existing?: { description: string | null; name: string; projectId: string };
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();

  const save = useMutation({
    mutationFn: async (value: ProjectFormValues) => {
      const payload = {
        description: value.description || undefined,
        name: value.name,
      };
      if (existing) {
        await renameProject({
          data: { ...payload, projectId: existing.projectId },
        });
        return null;
      }
      return await createProject({ data: { ...payload } });
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries();
      await router.invalidate();
      onOpenChange(false);
      if (created) {
        navigate({
          params: {
            environmentId: created.environmentId,
            projectId: created.projectId,
          },
          to: "/projects/$projectId/$environmentId",
        });
      }
    },
  });

  const form = useAppForm({
    defaultValues: {
      description: existing?.description ?? "",
      name: existing?.name ?? "",
    } as ProjectFormValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: projectFormSchema },
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
          <DialogTitle>
            {existing ? `Rename ${existing.name}` : "Create a project"}
          </DialogTitle>
          <DialogDescription>
            {existing
              ? "Only the label changes. Nothing is redeployed."
              : "A project groups environments. It starts with one called production; add more from inside."}
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
                    placeholder="marketing-site"
                    required
                  />
                )}
              </form.AppField>
              <form.AppField name="description">
                {(f) => <f.FieldTextarea label="Description (optional)" />}
              </form.AppField>
              {save.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(save.error, "could not save")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button disabled={save.isPending} type="submit">
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              {existing ? "Save" : "Create project"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({
  name,
  onOpenChange,
  open,
  projectId,
}: {
  name: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => deleteProject({ data: { projectId } }),
    onError: (e: Error) => setError(errorMessage(e, "could not delete")),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
      onOpenChange(false);
    },
  });

  const handleConfirm = useCallback(() => remove.mutate(), [remove]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            Only possible while it is empty. Remove its services, stacks and
            databases first. Its environments go with it.
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
            Delete project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
