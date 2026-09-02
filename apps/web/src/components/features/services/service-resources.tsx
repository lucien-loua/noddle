import { useQuery } from "@tanstack/react-query";

import {
  DEFAULT_WINDOW_HOURS,
  ResourcePanel,
} from "@/components/resource-panel";
import { queries } from "@/lib/queries";

export function ServiceResources({ serviceId }: { serviceId: string }) {
  const metrics = useQuery(queries.serviceMetrics(serviceId));

  return (
    <ResourcePanel
      emptyNote={`No samples in the last ${DEFAULT_WINDOW_HOURS} hours. Resources are sampled every minute on running services.`}
      series={metrics.data}
      unboundedNote="No memory limit declared. This service is bounded by the machine."
    />
  );
}
