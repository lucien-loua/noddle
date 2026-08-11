import { useQuery } from "@tanstack/react-query";
import { ResourcePanel } from "@/components/resource-panel";
import { queryKeys } from "@/lib/query-keys";
import { getServiceMetrics } from "@/server/metrics";

export function ServiceResources({ serviceId }: { serviceId: string }) {
  const metrics = useQuery({
    queryFn: () => getServiceMetrics({ data: { serviceId } }),
    queryKey: queryKeys.serviceMetrics(serviceId),
  });

  return (
    <ResourcePanel
      emptyNote="No samples in the last six hours. Resources are sampled every minute on running services."
      series={metrics.data}
      unboundedNote="No memory limit declared — this service is bounded by the machine."
    />
  );
}
