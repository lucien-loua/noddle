import { DeploymentHistory } from "@/components/deployment-history";
import { WebhookPanel } from "@/components/features/webhooks/panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import type { DeploymentSummary } from "@/server/dashboard";

export function ServiceDeploymentsPanel({
  canManageWebhook,
  canRollback,
  currentDeploymentId,
  deployments,
  onGenerateWebhook,
  onGetWebhook,
  onRollback,
  onSelect,
  pending,
  rollbackError,
  serviceId,
  shown,
}: {
  canManageWebhook: boolean;
  canRollback: boolean;
  currentDeploymentId: string | null;
  deployments: DeploymentSummary[] | undefined;
  onGenerateWebhook: () => Promise<{ path: string; secret: string }>;
  onGetWebhook: () => Promise<{ configured: boolean; path: string }>;
  onRollback: (deploymentId: string) => void;
  onSelect: (deploymentId: string) => void;
  pending: boolean;
  rollbackError: string | null;
  serviceId: string;
  shown: string | null;
}) {
  const recentDeployments = deployments?.slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      <Frame variant="ghost">
        <FrameHeader>
          <FrameTitle>Deployments</FrameTitle>
          <FrameDescription>
            See the last 10 deployments for this application.
          </FrameDescription>
        </FrameHeader>
        <FramePanel
          className={
            recentDeployments && recentDeployments.length > 0
              ? "p-0"
              : undefined
          }
        >
          {recentDeployments ? (
            <DeploymentHistory
              canRollback={canRollback}
              currentDeploymentId={currentDeploymentId}
              deployments={recentDeployments}
              onRollback={onRollback}
              onSelect={onSelect}
              pending={pending}
              selectedId={shown}
            />
          ) : (
            <Spinner />
          )}
          {rollbackError ? (
            <Alert className="m-3" variant="destructive">
              <AlertDescription>{rollbackError}</AlertDescription>
            </Alert>
          ) : null}
        </FramePanel>
      </Frame>

      <WebhookPanel
        canManage={canManageWebhook}
        generateWebhook={onGenerateWebhook}
        getWebhook={onGetWebhook}
        queryKey={["webhook", "service", serviceId]}
      />
    </div>
  );
}
