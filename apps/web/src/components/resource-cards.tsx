import { DATABASE_ENGINE_LABEL } from "@noddle/shared/database-engines";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { AttachDatabaseDialog } from "@/components/attach-database-dialog";
import { DatabaseMark } from "@/components/features/database/database-mark";
import { ResourceRow } from "@/components/resource-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime, serviceLabel, shortSha } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import type { ServiceRow, StackRow } from "@/server/dashboard";
import type { DatabaseRow } from "@/server/databases";
import { triggerDeploy } from "@/server/deployments";
import { triggerStackDeploy } from "@/server/stacks";

/** The detail panel, in the SAME container as its row: a panel floating
 *  next to it wouldn't say what it belongs to. */
export function ServiceCard({
  onOpen,
  role,
  service,
}: {
  onOpen: (serviceId: string) => void;
  role: RoleName | null;
  service: ServiceRow;
}) {
  const navigate = useNavigate();
  const status = serviceLabel(service.status);
  const canDeploy = useCan(role, "service", "deploy");

  const handleSelect = useCallback(
    () => onOpen(service.id),
    [onOpen, service.id]
  );

  const deploy = useMutation({
    mutationFn: () => triggerDeploy({ data: { serviceId: service.id } }),
    onSuccess: async (result) => {
      await navigate({
        params: {
          environmentId: service.environmentId,
          projectId: service.projectId,
          serviceId: service.id,
        },
        search: { deployment: result.deploymentId },
        to: "/projects/$projectId/$environmentId/services/$serviceId",
      });
    },
  });

  const handleDeploy = useCallback(() => deploy.mutate(), [deploy]);

  return (
    <ResourceRow
      action={
        canDeploy ? (
          <Button disabled={deploy.isPending} onClick={handleDeploy} size="sm">
            {deploy.isPending ? <Spinner data-icon="inline-start" /> : null}
            Deploy
          </Button>
        ) : null
      }
      meta={
        service.lastDeployment
          ? `${shortSha(service.lastDeployment.commitSha)} · ${relativeTime(service.lastDeployment.createdAt)}`
          : null
      }
      name={service.name}
      onToggle={handleSelect}
      secondary={
        <>
          {service.serverName}
          {service.domain ? ` · ${service.domain}` : ""}
          {service.lastError ? (
            <span className="block text-destructive" role="status">
              {service.lastError}
            </span>
          ) : null}
        </>
      }
      tag={
        <>
          {service.prNumber === null ? null : (
            <Badge
              title="Preview environment for a pull request. It is removed when the pull request is closed."
              variant="outline"
            >
              PR #{service.prNumber}
            </Badge>
          )}
          {service.watching ? (
            <Badge
              title="Post-deploy watch running: Noddle is still observing this service and will roll it back if it starts crash-looping."
              variant="outline"
            >
              watching
            </Badge>
          ) : null}
        </>
      }
      tone={status.tone}
      toneLabel={status.label}
    />
  );
}

export function StackCard({
  onOpen,
  role,
  stack,
}: {
  onOpen: (stackId: string) => void;
  role: RoleName | null;
  stack: StackRow;
}) {
  const navigate = useNavigate();
  const status = serviceLabel(stack.status);
  const canDeploy = useCan(role, "service", "deploy");

  const handleSelect = useCallback(() => onOpen(stack.id), [onOpen, stack.id]);

  const deploy = useMutation({
    mutationFn: () => triggerStackDeploy({ data: { stackId: stack.id } }),
    onSuccess: async (result) => {
      await navigate({
        params: {
          environmentId: stack.environmentId,
          projectId: stack.projectId,
          stackId: stack.id,
        },
        search: { deployment: result.stackDeploymentId },
        to: "/projects/$projectId/$environmentId/stacks/$stackId",
      });
    },
  });

  const handleDeploy = useCallback(() => deploy.mutate(), [deploy]);

  return (
    <ResourceRow
      action={
        canDeploy ? (
          <Button disabled={deploy.isPending} onClick={handleDeploy} size="sm">
            {deploy.isPending ? <Spinner data-icon="inline-start" /> : null}
            Deploy
          </Button>
        ) : null
      }
      meta={
        stack.lastDeployment
          ? `${shortSha(stack.lastDeployment.commitSha)} · ${relativeTime(stack.lastDeployment.createdAt)}`
          : null
      }
      name={stack.name}
      onToggle={handleSelect}
      secondary={
        <>
          <span className="text-muted-foreground/70">stack · </span>
          {stack.serverName}
          {stack.domain ? ` · ${stack.domain}` : ""}
          {stack.lastError ? (
            <span className="block text-destructive" role="status">
              {stack.lastError}
            </span>
          ) : null}
        </>
      }
      tag={
        stack.watching ? (
          <Badge
            title="Post-deploy watch running: Noddle is still observing this stack and will roll it back if any of its services starts crash-looping."
            variant="outline"
          >
            watching
          </Badge>
        ) : null
      }
      tone={status.tone}
      toneLabel={status.label}
    />
  );
}

/**
 * The variable name PROPOSED when attaching the database to a service.
 *
 * A suggestion, not a rule: the field stays editable, so as not to
 * overwrite a variable the application already uses. The three SQL engines
 * share `DATABASE_URL` because that's the name libraries expect, regardless
 * of dialect.
 */
const DEFAULT_ENV_VAR_KEY: Record<DatabaseRow["engine"], string> = {
  mariadb: "DATABASE_URL",
  mongo: "MONGO_URL",
  mysql: "DATABASE_URL",
  postgres: "DATABASE_URL",
  redis: "REDIS_URL",
};

export function DatabaseCard({
  database,
  onOpen,
  role,
  services,
}: {
  database: DatabaseRow;
  onOpen: (databaseId: string) => void;
  role: RoleName | null;
  services: ServiceRow[];
}) {
  const status = serviceLabel(database.status);
  const canAttach = useCan(role, "database", "attach");
  const handleSelect = useCallback(
    () => onOpen(database.id),
    [database.id, onOpen]
  );

  return (
    <ResourceRow
      action={
        canAttach ? (
          <AttachDatabaseDialog
            databaseId={database.id}
            defaultKey={DEFAULT_ENV_VAR_KEY[database.engine]}
            services={services}
          />
        ) : null
      }
      mark={<DatabaseMark engine={database.engine} />}
      name={database.name}
      onToggle={handleSelect}
      secondary={
        <>
          <span className="text-muted-foreground/70">
            {DATABASE_ENGINE_LABEL[database.engine]} ·{" "}
          </span>
          {database.serverName}
          {database.lastError ? (
            <span className="block text-destructive" role="status">
              {database.lastError}
            </span>
          ) : null}
        </>
      }
      tone={status.tone}
      toneLabel={status.label}
    />
  );
}
