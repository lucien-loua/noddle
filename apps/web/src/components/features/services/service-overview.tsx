import type { ServiceRow } from "@/server/dashboard";

import { ServiceBuild } from "./service-build";
import { ServiceProvider } from "./service-provider";

export function ServiceOverview({
  canEdit,
  service,
}: {
  canEdit: boolean;
  service: ServiceRow;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ServiceProvider canEdit={canEdit} service={service} />
      <ServiceBuild canEdit={canEdit} service={service} />
      {service.status === "created" ? (
        <p className="text-muted-foreground text-sm">
          Nothing is running yet. Save the repository, then Deploy.
        </p>
      ) : null}
    </div>
  );
}
