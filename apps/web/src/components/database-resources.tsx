import { useQuery } from "@tanstack/react-query";
import { ResourcePanel } from "@/components/resource-panel";
import { getDatabaseMetrics } from "@/server/metrics";

export function DatabaseResources({ databaseId }: { databaseId: string }) {
  const metrics = useQuery({
    queryFn: () => getDatabaseMetrics({ data: { databaseId } }),
    queryKey: ["database-metrics", databaseId],
  });

  return (
    <ResourcePanel
      emptyNote="No samples in the last six hours. Resources are sampled every minute on running databases."
      series={metrics.data}
      unboundedNote="No memory limit declared — this database is bounded by the machine."
    />
  );
}
