import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import type { ProjectGroup } from "@/server/dashboard";
import { moveService } from "@/server/services";

export function MoveServiceDialog({
  currentEnvironmentId,
  groups,
  onMoved,
  onOpenChange,
  open,
  serviceId,
  serviceName,
}: {
  currentEnvironmentId: string;
  /** Used ONLY to populate step 1 (choosing the PROJECT): this list never
   *  misses a project, since a project today only exists via an already
   *  connected resource. */
  groups: ProjectGroup[];
  /** Caller refreshes environment scope + route loaders (counts). */
  onMoved: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  serviceId: string;
  serviceName: string;
}) {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive, groups can be empty
  const [projectId, setProjectId] = useState(groups[0]?.projectId ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const environmentsQuery = useQuery({
    ...queries.projectEnvironments(projectId),
    enabled: open && Boolean(projectId),
  });
  const targetEnvironments = useMemo(
    () => (environmentsQuery.data ?? []).filter((env) => env.id !== currentEnvironmentId),
    [environmentsQuery.data, currentEnvironmentId],
  );

  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    // On open: the first project, its first valid target — never the
    // origin environment, whether from here or elsewhere.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive, groups can be empty
    const firstProject = groups[0]?.projectId ?? "";
    setProjectId(firstProject);
  }, [open, groups]);

  useEffect(() => {
    const [first] = targetEnvironments;
    setEnvironmentId(first?.id ?? "");
  }, [targetEnvironments]);

  const move = useMutation({
    mutationFn: () => moveService({ data: { environmentId, serviceId } }),
    onError: (e: Error) => setError(errorMessage(e, "could not move")),
    onSuccess: async () => {
      await onMoved();
      onOpenChange(false);
    },
  });

  const handleMove = useCallback(() => move.mutate(), [move]);
  const handleProjectChange = useCallback((next: unknown) => setProjectId(next as string), []);
  const handleEnvironmentChange = useCallback(
    (next: unknown) => setEnvironmentId(next as string),
    [],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {serviceName}</DialogTitle>
          <DialogDescription>
            Only its record changes project and environment. The running container, its server and
            its webhook URL stay exactly as they are.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="move-project">Project</FieldLabel>
              <Select
                items={Object.fromEntries(groups.map((g) => [g.projectId, g.project]))}
                onValueChange={handleProjectChange}
                value={projectId}
              >
                <SelectTrigger className="w-full" id="move-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {groups.map((g) => (
                      <SelectItem key={g.projectId} value={g.projectId}>
                        {g.project}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="move-environment">Environment</FieldLabel>
              {targetEnvironments.length === 0 ? (
                <Alert>
                  <AlertDescription>
                    {environmentsQuery.isLoading
                      ? "Loading…"
                      : "No other environment in this project. Pick a different project, or create one first."}
                  </AlertDescription>
                </Alert>
              ) : (
                <Select
                  items={Object.fromEntries(targetEnvironments.map((env) => [env.id, env.name]))}
                  onValueChange={handleEnvironmentChange}
                  value={environmentId}
                >
                  <SelectTrigger className="w-full" id="move-environment">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {targetEnvironments.map((env) => (
                        <SelectItem key={env.id} value={env.id}>
                          {env.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
            </Field>

            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </DialogBody>
        <DialogFooter>
          <Button disabled={!environmentId || move.isPending} onClick={handleMove}>
            {move.isPending ? <Spinner data-icon="inline-start" /> : null}
            Move service
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
