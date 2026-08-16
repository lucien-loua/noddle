import type { LifecycleAction } from "@/components/use-lifecycle-actions";
import {
  deploymentLabel,
  dotClass,
  serviceLabel,
  type Tone,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ServiceRow } from "@/server/dashboard";

const BUILD_METHOD_LABEL: Record<ServiceRow["buildMethod"], string> = {
  dockerfile: "Dockerfile",
  image: "Image",
  railpack: "Railpack",
};

const PENDING_LABEL: Record<LifecycleAction, string> = {
  restart: "Reloading",
  start: "Starting",
  stop: "Stopping",
};

const IN_FLIGHT_DEPLOYMENT = new Set(["queued", "building", "deploying"]);

function resolveStatus(
  service: ServiceRow,
  pendingAction: LifecycleAction | null
): { label: string; tone: Tone } {
  if (pendingAction) {
    return { label: PENDING_LABEL[pendingAction], tone: "busy" };
  }

  const deployment = service.lastDeployment;
  if (
    deployment &&
    !deployment.finishedAt &&
    IN_FLIGHT_DEPLOYMENT.has(deployment.status)
  ) {
    return deploymentLabel(deployment.status);
  }

  return serviceLabel(service.status);
}

export function ServiceStatusLine({
  pendingAction,
  service,
}: {
  pendingAction: LifecycleAction | null;
  service: ServiceRow;
}) {
  const status = resolveStatus(service, pendingAction);
  const pending =
    pendingAction !== null ||
    service.status === "deploying" ||
    Boolean(
      service.lastDeployment &&
        !service.lastDeployment.finishedAt &&
        IN_FLIGHT_DEPLOYMENT.has(service.lastDeployment.status)
    );
  const tone = pending ? "busy" : status.tone;

  return (
    <p className="flex min-w-0 items-center gap-2 truncate text-muted-foreground text-sm">
      <span
        aria-label={status.label}
        className={cn("size-2 shrink-0 rounded-full", dotClass(tone))}
        role="img"
      />
      <span className="shrink-0">{status.label}</span>
      {service.watching ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0">watching</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span className="shrink-0">
        {BUILD_METHOD_LABEL[service.buildMethod]}
      </span>
      <span aria-hidden>·</span>
      <span className="truncate">{service.serverName}</span>
    </p>
  );
}
