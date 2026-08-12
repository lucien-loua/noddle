import {
  ArrowClockwiseIcon,
  HammerIcon,
  PlayIcon,
  RocketLaunchIcon,
  StopIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  type LifecycleAction,
  useLifecycleActions,
} from "@/components/use-lifecycle-actions";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import type { ServiceRow } from "@/server/dashboard";

type ConfirmKind = "deploy" | "rebuild" | "reload" | "start" | "stop";

const CONFIRM_COPY: Record<
  ConfirmKind,
  { description: string; title: string }
> = {
  deploy: {
    description: "Are you sure you want to deploy this application?",
    title: "Deploy",
  },
  rebuild: {
    description:
      "Are you sure you want to rebuild this application? The latest source is fetched and the image is rebuilt from scratch.",
    title: "Rebuild",
  },
  reload: {
    description:
      "Are you sure you want to reload this application? This restarts the running container without rebuilding.",
    title: "Reload",
  },
  start: {
    description: "Are you sure you want to start this application?",
    title: "Start",
  },
  stop: {
    description: "Are you sure you want to stop this application?",
    title: "Stop",
  },
};

function DeploySettingsToolbar({
  actionsBusy,
  deployDisabled,
  deployPending,
  hasGit,
  onRequestDeploy,
  onRequestRebuild,
  onRequestReload,
  onRequestStartStop,
  onTerminal,
  pending,
  showDeploy,
  showReload,
  showRebuild,
  showStartStop,
  stopped,
}: {
  actionsBusy: boolean;
  deployDisabled: boolean;
  deployPending: boolean;
  hasGit: boolean;
  onRequestDeploy: () => void;
  onRequestRebuild: () => void;
  onRequestReload: () => void;
  onRequestStartStop: () => void;
  onTerminal: (() => void) | null;
  pending: boolean;
  showDeploy: boolean;
  showReload: boolean;
  showRebuild: boolean;
  showStartStop: boolean;
  stopped: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {showDeploy ? (
        <Button
          disabled={deployDisabled}
          onClick={onRequestDeploy}
          title={
            hasGit
              ? undefined
              : "Set a git repository on General before deploying"
          }
        >
          {deployPending ? <Spinner data-icon="inline-start" /> : null}
          <RocketLaunchIcon data-icon="inline-start" weight="fill" />
          Deploy
        </Button>
      ) : null}

      {showReload ? (
        <Button
          disabled={actionsBusy}
          onClick={onRequestReload}
          variant="outline"
        >
          <ArrowClockwiseIcon data-icon="inline-start" weight="fill" />
          Reload
        </Button>
      ) : null}

      {showRebuild ? (
        <Button
          disabled={deployDisabled}
          onClick={onRequestRebuild}
          title={
            hasGit
              ? undefined
              : "Set a git repository on General before rebuilding"
          }
          variant="outline"
        >
          <HammerIcon data-icon="inline-start" weight="fill" />
          Rebuild
        </Button>
      ) : null}

      {showStartStop ? (
        <Button
          disabled={actionsBusy}
          onClick={onRequestStartStop}
          variant={stopped ? "outline" : "destructive"}
        >
          {stopped ? (
            <PlayIcon data-icon="inline-start" weight="fill" />
          ) : (
            <StopIcon data-icon="inline-start" weight="fill" />
          )}
          {stopped ? "Start" : "Stop"}
        </Button>
      ) : null}

      {onTerminal ? (
        <Button onClick={onTerminal} variant="outline">
          <TerminalIcon data-icon="inline-start" weight="bold" />
          Open Terminal
        </Button>
      ) : null}

      {pending && !showDeploy ? (
        <Spinner className="text-muted-foreground" />
      ) : null}
    </div>
  );
}

export function ServiceDeploySettings({
  deployPending,
  known,
  onDeploy,
  onDone,
  onError,
  onTerminal,
  pendingAction,
  service,
}: {
  deployPending: boolean;
  known: RoleName | null;
  onDeploy: () => void;
  onDone: (action: LifecycleAction) => void;
  onError: (message: string) => void;
  onTerminal: (() => void) | null;
  pendingAction: LifecycleAction | null;
  service: ServiceRow;
}) {
  const canDeploy = useCan(known, "service", "deploy");
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

  const lifecycle = useLifecycleActions({
    onDone,
    onError,
    role: known,
    status: service.status,
    target: { resource: "service", serviceId: service.id },
  });

  const pending = pendingAction !== null || service.status === "deploying";
  const showDeploy =
    canDeploy &&
    service.status !== "deleting" &&
    service.status !== "deploying";
  const hasGit = Boolean(service.gitRepoUrl);
  const deployDisabled = pending || deployPending || !hasGit;
  const actionsBusy = lifecycle.busy || pending || deployPending;
  const showLifecycle = lifecycle.available;

  const closeConfirm = useCallback((open: boolean) => {
    if (!open) {
      setConfirm(null);
    }
  }, []);

  const requestDeploy = useCallback(() => setConfirm("deploy"), []);
  const requestRebuild = useCallback(() => setConfirm("rebuild"), []);
  const requestReload = useCallback(() => setConfirm("reload"), []);
  const requestStartStop = useCallback(
    () => setConfirm(lifecycle.stopped ? "start" : "stop"),
    [lifecycle.stopped]
  );

  const handleConfirmed = useCallback(() => {
    const kind = confirm;
    setConfirm(null);
    if (kind === "deploy" || kind === "rebuild") {
      onDeploy();
      return;
    }
    if (kind === "reload") {
      lifecycle.handleRestart();
      return;
    }
    lifecycle.handleStopStart();
  }, [confirm, lifecycle, onDeploy]);

  const copy = confirm ? CONFIRM_COPY[confirm] : null;

  if (
    !(showDeploy || showLifecycle || onTerminal) &&
    service.status === "deleting"
  ) {
    return null;
  }

  return (
    <>
      <DeploySettingsToolbar
        actionsBusy={actionsBusy}
        deployDisabled={deployDisabled}
        deployPending={deployPending}
        hasGit={hasGit}
        onRequestDeploy={requestDeploy}
        onRequestRebuild={requestRebuild}
        onRequestReload={requestReload}
        onRequestStartStop={requestStartStop}
        onTerminal={onTerminal}
        pending={pending}
        showDeploy={showDeploy}
        showRebuild={showDeploy}
        showReload={showLifecycle && lifecycle.showRestart}
        showStartStop={showLifecycle}
        stopped={lifecycle.stopped}
      />

      {copy ? (
        <ConfirmActionDialog
          description={copy.description}
          onConfirm={handleConfirmed}
          onOpenChange={closeConfirm}
          open
          pending={deployPending || lifecycle.busy}
          title={copy.title}
        />
      ) : null}
    </>
  );
}
