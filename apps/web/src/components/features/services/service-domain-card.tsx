import {
  ArrowSquareOutIcon,
  InfoIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FramePanel } from "@/components/ui/frame";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ServiceDomainRow } from "@/server/dashboard";

function certLabel(domain: ServiceDomainRow): string {
  if (!domain.https) {
    return "none";
  }
  if (domain.certificateType === "letsencrypt") {
    return "Let's Encrypt";
  }
  return domain.certificateType;
}

function pathBadgeLabel(domain: ServiceDomainRow): string {
  const parts: string[] = [domain.path === "/" ? "/" : domain.path];
  if (domain.stripPath) {
    parts.push("strip");
  }
  if (domain.internalPath) {
    parts.push(`→ ${domain.internalPath}`);
  }
  return parts.join(" · ");
}

function routingLabel(
  domain: ServiceDomainRow,
  lastDeploymentFinishedAt: string | null
): string {
  if (lastDeploymentFinishedAt === null) {
    return "Redeploy required";
  }
  if (domain.updatedAt > lastDeploymentFinishedAt) {
    return "Redeploy required";
  }
  return "Active";
}

function routingNeedsRedeploy(
  domain: ServiceDomainRow,
  lastDeploymentFinishedAt: string | null
): boolean {
  if (lastDeploymentFinishedAt === null) {
    return true;
  }
  return domain.updatedAt > lastDeploymentFinishedAt;
}

export function ServiceDomainCard({
  canEdit,
  domain,
  lastDeploymentFinishedAt,
  onEdit,
  onRemove,
  port,
}: {
  canEdit: boolean;
  domain: ServiceDomainRow;
  lastDeploymentFinishedAt: string | null;
  onEdit: () => void;
  onRemove: () => void;
  port: number;
}) {
  const scheme = domain.https ? "https" : "http";
  const publicPath = domain.path === "/" ? "" : domain.path;
  const routing = routingLabel(domain, lastDeploymentFinishedAt);
  const pendingDeploy = routingNeedsRedeploy(domain, lastDeploymentFinishedAt);

  return (
    <FramePanel>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-sm">
            <a
              className="inline-flex items-center gap-1 hover:underline"
              href={`${scheme}://${domain.host}${publicPath}`}
              rel="noreferrer noopener"
              target="_blank"
            >
              {domain.host}
              {publicPath ? publicPath : null}
              <ArrowSquareOutIcon
                className="size-3.5 shrink-0"
                weight="regular"
              />
            </a>
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <DetailBadge
              label={`Path: ${pathBadgeLabel(domain)}`}
              tip="Public URL path prefix and forwarding rules"
            />
            <DetailBadge
              label={`Port: ${port}`}
              tip="Container port Traefik forwards to"
            />
            <DetailBadge
              label={domain.https ? "HTTPS" : "HTTP"}
              tip={
                domain.https
                  ? "Secure HTTPS connection"
                  : "Standard HTTP connection"
              }
            />
            {domain.https ? (
              <DetailBadge
                label={`Cert: ${certLabel(domain)}`}
                tip="SSL certificate provider"
              />
            ) : null}
            <Badge
              className={cn(
                pendingDeploy &&
                  "border-amber-500/40 text-amber-700 dark:text-amber-400"
              )}
              variant="outline"
            >
              {routing}
            </Badge>
          </div>
        </div>
        {canEdit ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              aria-label="Edit domain"
              onClick={onEdit}
              size="icon-sm"
              variant="ghost"
            >
              <PencilSimpleIcon />
            </Button>
            <Button
              aria-label="Remove domain"
              onClick={onRemove}
              size="icon-sm"
              variant="ghost"
            >
              <TrashIcon />
            </Button>
          </div>
        ) : null}
      </div>
    </FramePanel>
  );
}

function DetailBadge({ label, tip }: { label: string; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge className="font-normal" variant="secondary">
            <InfoIcon className="mr-1 size-3" />
            {label}
          </Badge>
        }
      />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
