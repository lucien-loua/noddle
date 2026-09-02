import { DeploymentHistory } from "@/components/deployment-history";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import type { DeploymentSummary } from "@/server/dashboard";

export function StackHistoryPanel({
  canRollback,
  currentDeploymentId,
  deployments,
  gitBranch,
  gitRepoUrl,
  onRollback,
  onSelect,
  pending,
  rollbackError,
  selectedId,
}: {
  canRollback: boolean;
  currentDeploymentId: string | null;
  deployments: DeploymentSummary[] | undefined;
  gitBranch: string | null;
  gitRepoUrl: string;
  onRollback: (deploymentId: string) => void;
  onSelect: (deploymentId: string) => void;
  pending: boolean;
  rollbackError: string | null;
  selectedId: string | null;
}) {
  return (
    <>
      <p className="mb-2 truncate text-muted-foreground text-xs">
        {gitRepoUrl}
        {gitBranch ? ` · ${gitBranch}` : ""}
      </p>
      {deployments ? (
        <DeploymentHistory
          canRollback={canRollback}
          currentDeploymentId={currentDeploymentId}
          deployments={deployments}
          onRollback={onRollback}
          onSelect={onSelect}
          pending={pending}
          selectedId={selectedId}
        />
      ) : (
        <Spinner />
      )}
      {rollbackError ? (
        <Alert className="mt-3" variant="destructive">
          <AlertDescription>{rollbackError}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
