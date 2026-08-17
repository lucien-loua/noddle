/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */
import { GlobeIcon, PlusIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { ServiceDomainCard } from "@/components/features/services/service-domain-card";
import { ServiceDomainDialog } from "@/components/features/services/service-domain-dialog";
import { IconStack } from "@/components/icon-stack";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import type { ServiceDomainRow, ServiceRow } from "@/server/dashboard";
import { deleteServiceDomain } from "@/server/service-domains";

const DOMAIN_REDEPLOY_HINT =
  "Whenever you make changes to domains, remember to redeploy the application to apply the changes.";

export function ServiceDomains({ canEdit, service }: { canEdit: boolean; service: ServiceRow }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [editor, setEditor] = useState<ServiceDomainRow | "new" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ServiceDomainRow | null>(null);

  const remove = useMutation({
    mutationFn: (domainId: string) => deleteServiceDomain({ data: { domainId } }),
    onSuccess: async () => {
      setConfirmRemove(null);
      await cache.service(queryClient, service.id);
      await router.invalidate();
    },
  });

  const handleOpenCreate = useCallback(() => setEditor("new"), []);
  const handleDialogChange = useCallback((open: boolean) => {
    if (!open) {
      setEditor(null);
    }
  }, []);
  const handleRemoveOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setConfirmRemove(null);
    }
  }, []);

  const hasDomains = service.domains.length > 0;

  return (
    <>
      <Frame className="w-full" stacked variant="ghost">
        <FrameHeader className="flex-row items-center justify-between gap-3">
          <div className="min-w-0">
            <FrameTitle>Domains</FrameTitle>
            <FrameDescription>Domains are used to access the application.</FrameDescription>
          </div>
          {canEdit && hasDomains ? (
            <Button onClick={handleOpenCreate} size="sm" variant="outline">
              <PlusIcon data-icon="inline-start" weight="regular" />
              Add domain
            </Button>
          ) : null}
        </FrameHeader>

        {hasDomains ? (
          <>
            {service.domains.map((domain) => (
              <ServiceDomainCard
                canEdit={canEdit}
                domain={domain}
                key={domain.id}
                lastDeploymentFinishedAt={service.lastDeployment?.finishedAt ?? null}
                onEdit={() => setEditor(domain)}
                onRemove={() => setConfirmRemove(domain)}
                port={service.port}
              />
            ))}
            {remove.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {errorMessage(remove.error, "could not remove domain")}
              </p>
            ) : null}
            <FrameFooter>
              <p className="text-muted-foreground text-xs">{DOMAIN_REDEPLOY_HINT}</p>
            </FrameFooter>
          </>
        ) : (
          <FramePanel>
            <Empty>
              <EmptyMedia>
                <IconStack>
                  <GlobeIcon className="size-5" />
                </IconStack>
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No domain yet</EmptyTitle>
                <EmptyDescription>
                  To access the application it is required to set at least one domain.
                </EmptyDescription>
              </EmptyHeader>
              {canEdit ? (
                <EmptyContent>
                  <Button onClick={handleOpenCreate}>
                    <GlobeIcon data-icon="inline-start" weight="fill" />
                    Add domain
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          </FramePanel>
        )}
      </Frame>

      {editor ? (
        <ServiceDomainDialog
          domain={editor === "new" ? null : editor}
          onOpenChange={handleDialogChange}
          open
          service={service}
        />
      ) : null}

      <ConfirmActionDialog
        confirmLabel="Remove"
        description="The public route is cleared on save. Redeploy to stop Traefik from routing to this hostname."
        onConfirm={() => {
          if (confirmRemove) {
            remove.mutate(confirmRemove.id);
          }
        }}
        onOpenChange={handleRemoveOpenChange}
        open={confirmRemove !== null}
        pending={remove.isPending}
        title="Remove domain?"
      />
    </>
  );
}
