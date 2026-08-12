import { LogStream } from "@/components/log-stream";
import { Badge } from "@/components/ui/badge";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalDescription,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import {
  badgeVariant,
  deploymentLabel,
  duration,
  shortSha,
  triggerLabel,
} from "@/lib/format";
import type { DeploymentSummary } from "@/server/dashboard";

export function BuildLogsDialog({
  deployment,
  deploymentId,
  onEnd,
  onOpenChange,
  open,
}: {
  deployment: DeploymentSummary | null;
  deploymentId: string | null;
  onEnd: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const status = deployment ? deploymentLabel(deployment.status) : null;
  const meta = deployment
    ? [
        shortSha(deployment.commitSha),
        triggerLabel(deployment.trigger),
        duration(deployment.createdAt, deployment.finishedAt),
      ]
        .filter((part) => part !== "—")
        .join(" · ")
    : "";

  return (
    <FocusModal
      onOpenChange={onOpenChange}
      open={open && deploymentId !== null}
    >
      <FocusModalContent>
        {deploymentId ? (
          <LogStream.Session deploymentId={deploymentId} onEnd={onEnd}>
            <FocusModalHeader>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <FocusModalTitle>Build logs</FocusModalTitle>
                  {meta ? (
                    <FocusModalDescription>{meta}</FocusModalDescription>
                  ) : null}
                </div>
                {status ? (
                  <Badge variant={badgeVariant(status.tone)}>
                    {status.label}
                  </Badge>
                ) : null}
                <LogStream.Copy />
              </div>
            </FocusModalHeader>
            <FocusModalBody className="mask-none flex min-h-0 flex-col overflow-hidden p-0">
              <LogStream.View plain />
            </FocusModalBody>
          </LogStream.Session>
        ) : null}
      </FocusModalContent>
    </FocusModal>
  );
}
