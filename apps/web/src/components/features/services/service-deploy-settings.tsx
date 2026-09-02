import {
  ArrowClockwiseIcon,
  HammerIcon,
  PlayIcon,
  RocketLaunchIcon,
  StopIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import type { ResourceActions } from "@/lib/resource-actions/use-resource-actions";
import { serviceRow } from "@/lib/scope-rows";
import { useCan } from "@/lib/use-permission";
import type { ServiceRow } from "@/server/dashboard";
import { updateServiceSettings } from "@/server/services";

type ConfirmKind = "deploy" | "rebuild" | "reload" | "start" | "stop";

const CONFIRM_COPY: Record<
  ConfirmKind,
  { confirmLabel: string; description: string; title: string }
> = {
  deploy: {
    confirmLabel: "Deploy",
    description:
      "The image is built and rolled out. The running version keeps serving until the new one is healthy.",
    title: "Deploy this application?",
  },
  rebuild: {
    confirmLabel: "Rebuild",
    description:
      "The latest source is fetched and the image is rebuilt from scratch.",
    title: "Rebuild this application?",
  },
  reload: {
    confirmLabel: "Reload",
    description:
      "The running container is restarted. Nothing is rebuilt and the image does not change.",
    title: "Reload this application?",
  },
  start: {
    confirmLabel: "Start",
    description: "The application starts again on its current image.",
    title: "Start this application?",
  },
  stop: {
    confirmLabel: "Stop",
    description:
      "The application stops answering. Nothing is deleted, and you can start it again at any time.",
    title: "Stop this application?",
  },
};

function DeploySettingsToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

const autoDeployPatch = (next: boolean) => ({ autoDeploy: next });
const cleanCachePatch = (next: boolean) => ({ cleanCache: next });

function DeployToggle({
  checked,
  disabled,
  label,
  onSaved,
  patch,
  serviceId,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onSaved: () => Promise<void>;
  patch: (next: boolean) => { autoDeploy?: boolean; cleanCache?: boolean };
  serviceId: string;
}) {
  const id = useId();
  const save = useMutation({
    mutationFn: (next: boolean) =>
      updateServiceSettings({ data: { serviceId, ...patch(next) } }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, `${label} was not changed`),
        title: "Not saved",
        type: "error",
      }),
    onSuccess: onSaved,
  });

  const isDisabled = disabled || save.isPending;

  const handleChange = useCallback(
    (next: boolean) => save.mutate(next),
    [save]
  );

  return (
    <FieldLabel
      className="has-[>[data-slot=field]]:w-fit has-[>[data-slot=field]]:rounded-4xl *:data-[slot=field]:h-9 *:data-[slot=field]:px-3 *:data-[slot=field]:py-0"
      htmlFor={id}
    >
      <Field
        className="w-fit"
        data-disabled={isDisabled || undefined}
        orientation="horizontal"
      >
        <FieldTitle>{label}</FieldTitle>
        <Switch
          checked={checked}
          disabled={isDisabled}
          id={id}
          onCheckedChange={handleChange}
          size="sm"
        />
      </Field>
    </FieldLabel>
  );
}

function StartStopButton({
  busy,
  onClick,
  stopped,
}: {
  busy: boolean;
  onClick: () => void;
  stopped: boolean;
}) {
  return (
    <Button
      disabled={busy}
      onClick={onClick}
      variant={stopped ? "outline" : "destructive"}
    >
      {stopped ? (
        <PlayIcon data-icon="inline-start" weight="fill" />
      ) : (
        <StopIcon data-icon="inline-start" weight="fill" />
      )}
      {stopped ? "Start" : "Stop"}
    </Button>
  );
}

function DeployToggles({
  busy,
  onSaved,
  service,
}: {
  busy: boolean;
  onSaved: () => Promise<void>;
  service: ServiceRow;
}) {
  return (
    <>
      <DeployToggle
        checked={service.autoDeploy}
        disabled={busy}
        label="Autodeploy"
        onSaved={onSaved}
        patch={autoDeployPatch}
        serviceId={service.id}
      />
      {service.sourceType === "docker_image" ? null : (
        <DeployToggle
          checked={service.cleanCache}
          disabled={busy}
          label="Clean cache"
          onSaved={onSaved}
          patch={cleanCachePatch}
          serviceId={service.id}
        />
      )}
    </>
  );
}

interface ActionBarFlags {
  actionsBusy: boolean;
  canDeploy: boolean;
  deployAllowed: boolean;
  deployDisabled: boolean;
  deployPending: boolean;
  hasSource: boolean;
  pending: boolean;
  showLifecycle: boolean;
  showRestart: boolean;
  stopped: boolean;
}

interface ActionBarHandlers {
  onDeploy: () => void;
  onRebuild: () => void;
  onReload: () => void;
  onStartStop: () => void;
  onTerminal: (() => void) | null;
}

function DeployActionBar({
  flags,
  handlers,
  onSaved,
  service,
}: {
  flags: ActionBarFlags;
  handlers: ActionBarHandlers;
  onSaved: () => Promise<void>;
  service: ServiceRow;
}) {
  const {
    actionsBusy,
    canDeploy,
    deployAllowed,
    deployDisabled,
    deployPending,
    hasSource,
    pending,
    showLifecycle,
    showRestart,
    stopped,
  } = flags;

  return (
    <DeploySettingsToolbar>
      {deployAllowed ? (
        <Button
          disabled={deployDisabled}
          onClick={handlers.onDeploy}
          title={
            hasSource ? undefined : "Set a source on General before deploying"
          }
        >
          {deployPending ? <Spinner data-icon="inline-start" /> : null}
          <RocketLaunchIcon data-icon="inline-start" weight="fill" />
          Deploy
        </Button>
      ) : null}

      {showLifecycle && showRestart ? (
        <Button
          disabled={actionsBusy}
          onClick={handlers.onReload}
          variant="outline"
        >
          <ArrowClockwiseIcon data-icon="inline-start" weight="fill" />
          Reload
        </Button>
      ) : null}

      {deployAllowed ? (
        <Button
          disabled={deployDisabled}
          onClick={handlers.onRebuild}
          title={
            hasSource ? undefined : "Set a source on General before rebuilding"
          }
          variant="outline"
        >
          <HammerIcon data-icon="inline-start" weight="fill" />
          Rebuild
        </Button>
      ) : null}

      {showLifecycle ? (
        <StartStopButton
          busy={actionsBusy}
          onClick={handlers.onStartStop}
          stopped={stopped}
        />
      ) : null}

      {handlers.onTerminal ? (
        <Button onClick={handlers.onTerminal} variant="outline">
          <TerminalIcon data-icon="inline-start" weight="regular" />
          Open terminal
        </Button>
      ) : null}

      {canDeploy ? (
        <DeployToggles busy={actionsBusy} onSaved={onSaved} service={service} />
      ) : null}

      {pending && !deployAllowed ? (
        <Spinner className="text-muted-foreground" />
      ) : null}
    </DeploySettingsToolbar>
  );
}

export function ServiceDeploySettings({
  actions,
  deployPending,
  known,
  onDeploy,
  onDone,
  onError,
  onTerminal,
  service,
}: {
  actions: ResourceActions;
  deployPending: boolean;
  known: RoleName | null;
  onDeploy: () => void;
  onDone: () => Promise<void> | void;
  onError: (message: string) => void;
  onTerminal: (() => void) | null;
  service: ServiceRow;
}) {
  const canDeploy = useCan(known, "service", "deploy");
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

  const target = useMemo(() => serviceRow(service), [service]);
  const available = actions.actionsFor(target);
  const status = actions.statusOf(target);
  const stopped = service.status === "stopped";

  const lifecycle = useMutation({
    mutationFn: (action: "restart" | "start" | "stop") =>
      actions.run(target, action),
    onError: (e: Error) => onError(errorMessage(e, "the action was refused")),
    onSuccess: () => onDone(),
  });

  const pending = status.tone === "busy";
  const deployAllowed = available.has("deploy");
  const hasSource =
    service.sourceType === "docker_image"
      ? Boolean(service.dockerImage)
      : Boolean(service.gitRepoUrl);
  const deployDisabled = pending || deployPending || !hasSource;
  const actionsBusy = lifecycle.isPending || pending || deployPending;
  const showLifecycle = available.has("start") || available.has("stop");
  const showRestart = available.has("restart");

  const queryClient = useQueryClient();
  const router = useRouter();
  const refreshService = useCallback(async () => {
    await cache.service(queryClient, service.id);
    await router.invalidate();
  }, [queryClient, router, service.id]);

  const closeConfirm = useCallback((open: boolean) => {
    if (!open) {
      setConfirm(null);
    }
  }, []);

  const requestDeploy = useCallback(() => setConfirm("deploy"), []);
  const requestRebuild = useCallback(() => setConfirm("rebuild"), []);
  const requestReload = useCallback(() => setConfirm("reload"), []);
  const requestStartStop = useCallback(
    () => setConfirm(stopped ? "start" : "stop"),
    [stopped]
  );

  const handleConfirmed = useCallback(() => {
    const kind = confirm;
    setConfirm(null);
    if (kind === "deploy" || kind === "rebuild") {
      onDeploy();
      return;
    }
    if (kind === "reload") {
      lifecycle.mutate("restart");
      return;
    }
    lifecycle.mutate(stopped ? "start" : "stop");
  }, [confirm, lifecycle, onDeploy, stopped]);

  const copy = confirm ? CONFIRM_COPY[confirm] : null;

  if (
    !(deployAllowed || showLifecycle || onTerminal) &&
    service.status === "deleting"
  ) {
    return null;
  }

  return (
    <>
      <DeployActionBar
        flags={{
          actionsBusy,
          canDeploy,
          deployAllowed,
          deployDisabled,
          deployPending,
          hasSource,
          pending,
          showLifecycle,
          showRestart,
          stopped,
        }}
        handlers={{
          onDeploy: requestDeploy,
          onRebuild: requestRebuild,
          onReload: requestReload,
          onStartStop: requestStartStop,
          onTerminal,
        }}
        onSaved={refreshService}
        service={service}
      />

      {copy ? (
        <ConfirmActionDialog
          confirmLabel={copy.confirmLabel}
          description={copy.description}
          onConfirm={handleConfirmed}
          onOpenChange={closeConfirm}
          open
          pending={deployPending || lifecycle.isPending}
          title={copy.title}
        />
      ) : null}
    </>
  );
}
