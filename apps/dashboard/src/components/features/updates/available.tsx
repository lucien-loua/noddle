import { ArrowCircleUpIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { getUpdateStatus } from "@/server/updates";
import type { UpdateStatus } from "@/server/updates";

const STALE_MS = 30 * 60 * 1000;

export function UpdateAvailable({ role }: { role?: string | null }) {
  const known = role && role in roles ? (role as RoleName) : null;
  const canUpdate = useCan(known, "installation", "update");

  const { data } = useQuery<UpdateStatus>({
    enabled: canUpdate,
    queryFn: () => getUpdateStatus(),
    queryKey: queries.updateStatus().queryKey,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: STALE_MS,
  });

  if (!(canUpdate && data?.updatable)) {
    return null;
  }

  const label = data.remoteVersion
    ? `${data.remoteVersion} available`
    : "Update available";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={<Link to="/settings" />} tooltip={label}>
        <ArrowCircleUpIcon data-icon="inline-start" weight="regular" />
        <span className="truncate group-data-[collapsible=icon]:hidden">
          {label}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
