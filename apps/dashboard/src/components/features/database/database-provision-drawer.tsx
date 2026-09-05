import { XIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";

import { LogStream } from "@/components/log-stream";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import { deploymentLabel, duration, triggerLabel } from "@/lib/format";
import type { DeploymentSummary } from "@/server/dashboard";

const DRAWER_WIDTH = {
  "--drawer-content-width": "min(52rem, calc(100vw - 1rem))",
} as CSSProperties;

export function DatabaseProvisionDrawer({
  deployment,
  deploymentId,
  onEnd,
  onOpenChange,
}: {
  deployment: DeploymentSummary | null;
  deploymentId: string | null;
  onEnd: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const status = deployment ? deploymentLabel(deployment.status) : null;
  const meta = deployment
    ? [
        deployment.imageTag,
        triggerLabel(deployment.trigger),
        duration(deployment.createdAt, deployment.finishedAt),
      ]
        .filter((part) => part && part !== "—")
        .join(" · ")
    : "";

  return (
    <Drawer
      onOpenChange={onOpenChange}
      open={deploymentId !== null}
      swipeDirection="right"
    >
      <DrawerContent style={DRAWER_WIDTH}>
        {deploymentId ? (
          <LogStream.Session deploymentId={deploymentId} onEnd={onEnd}>
            <DrawerHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <DrawerTitle className="min-w-0 truncate text-sm">
                    Provisioning
                  </DrawerTitle>
                  {meta ? <DrawerDescription>{meta}</DrawerDescription> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {status ? (
                    <Status tone={status.tone}>
                      <StatusIndicator />
                      <StatusLabel>{status.label}</StatusLabel>
                    </Status>
                  ) : null}
                  <LogStream.Copy />
                  <DrawerClose
                    aria-label="Close"
                    className="-me-1 shrink-0 rounded-4xl p-1 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    <XIcon className="size-4" weight="regular" />
                  </DrawerClose>
                </div>
              </div>
            </DrawerHeader>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 pt-0">
              <LogStream.View plain />
            </div>
          </LogStream.Session>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
