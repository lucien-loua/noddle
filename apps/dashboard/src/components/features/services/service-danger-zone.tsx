import { TrashIcon } from "@phosphor-icons/react";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { useDeleteResourceAction } from "@/components/use-delete-resource-action";
import type { RoleName } from "@/lib/permissions";
import type {
  ResourceActions,
  Target,
} from "@/lib/resource-actions/use-resource-actions";

export function ServiceDangerZone({
  actions,
  onDeleted,
  onError,
  role,
  target,
}: {
  actions: ResourceActions;
  onDeleted: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  target: Target;
}) {
  const runDelete = useCallback(
    (confirmName: string) => actions.run(target, "delete", { confirmName }),
    [actions, target]
  );

  const del = useDeleteResourceAction({
    id: target.id,
    kind: "service",
    name: target.name,
    onDeleted,
    onError,
    role,
    run: runDelete,
  });

  if (!del.canDelete) {
    return null;
  }

  return (
    <>
      <Frame variant="ghost">
        <FrameHeader>
          <FrameTitle>Danger zone</FrameTitle>
        </FrameHeader>
        <FramePanel>
          <h3 className="mb-1 font-semibold text-sm">Delete application</h3>
          <p className="text-muted-foreground text-sm">
            Stops the running container and removes every deployment, build log,
            environment variable and registry image for {target.name}. This
            cannot be undone.
          </p>
        </FramePanel>
        <FrameFooter>
          <Button
            className="w-full"
            onClick={del.handleOpen}
            variant="destructive"
          >
            <TrashIcon data-icon="inline-start" weight="regular" />
            Delete application
          </Button>
        </FrameFooter>
      </Frame>

      {del.dialog}
    </>
  );
}
