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
  const fromImage = service.sourceType === "docker_image";

  return (
    <div className="flex flex-col gap-4">
      <ServiceProvider canEdit={canEdit} service={service} />
      {fromImage ? null : <ServiceBuild canEdit={canEdit} service={service} />}
      {service.status === "created" ? (
        <p className="text-muted-foreground text-sm">
          {fromImage
            ? "Nothing is running yet. Save the image, then Deploy."
            : "Nothing is running yet. Save the repository, then Deploy."}
        </p>
      ) : null}
    </div>
  );
}
