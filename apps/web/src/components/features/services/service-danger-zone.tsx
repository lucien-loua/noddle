import { TrashIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { useDeleteServiceAction } from "@/components/use-delete-service-action";
import type { RoleName } from "@/lib/permissions";

export function ServiceDangerZone({
  onDeleted,
  onError,
  role,
  serviceId,
  serviceName,
}: {
  onDeleted: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  serviceId: string;
  serviceName: string;
}) {
  const del = useDeleteServiceAction({
    onDeleted,
    onError,
    role,
    serviceId,
    serviceName,
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
            environment variable and registry image for {serviceName}. This
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
