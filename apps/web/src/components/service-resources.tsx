// Les ressources d'un service, dans son détail.
//
// Les mêmes briques que pour une machine (`Sparkline`, `MetricRow`,
// `withGaps`), réutilisées telles quelles : dupliquer la logique de trous
// serait la garantie qu'une des deux copies finisse par relier les segments,
// et c'est précisément ce que tout ce chantier refuse.
import { useQuery } from "@tanstack/react-query";
import { MetricRow } from "@/components/resource-graphs";
import { Badge } from "@/components/ui/badge";
import { byteSize } from "@/lib/format";
import { getServiceMetrics, type ServicePoint } from "@/server/metrics";

/** Le plafond de l'axe CPU quand le service reste sous 100 % d'un cœur. */
const CPU_FLOOR = 100;

const readCpu = (p: ServicePoint) => p.cpuPercent;
const readMemory = (p: ServicePoint) => p.memoryUsedBytes;

export function ServiceResources({ serviceId }: { serviceId: string }) {
  const metrics = useQuery({
    queryFn: () => getServiceMetrics({ data: { serviceId } }),
    queryKey: ["service-metrics", serviceId],
  });

  const series = metrics.data;
  if (!series || series.points.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No samples in the last six hours. Resources are sampled every minute on
        running services.
      </p>
    );
  }

  const { latest, points, restarts } = series;
  if (!latest) {
    return null;
  }

  // Le plafond suit le pic observé plutôt que d'être figé : un service qui
  // monte à 300 % de CPU (trois cœurs) doit rester lisible, et un service qui
  // plafonne à 4 % ne doit pas s'écraser sur la ligne du bas.
  const cpuMax = Math.max(CPU_FLOOR, ...points.map(readCpu));
  const memMax = Math.max(...points.map(readMemory));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">Last six hours</span>
        {restarts > 1 ? (
          // Sans ça, une chute brutale de mémoire se lirait comme une fuite
          // corrigée alors que c'est un nouveau conteneur qui démarre.
          <Badge
            title="The series spans several successive containers: a break may be a redeploy, not a change in behaviour."
            variant="outline"
          >
            {restarts} containers over the period
          </Badge>
        ) : null}
      </div>

      <MetricRow
        label="CPU"
        max={cpuMax}
        points={points}
        reading={`${latest.cpuPercent.toFixed(1)} %`}
        value={readCpu}
      />
      <MetricRow
        label="Memory"
        max={memMax}
        points={points}
        reading={
          latest.memoryUsedRatio === null
            ? byteSize(latest.memoryUsedBytes)
            : `${Math.round(latest.memoryUsedRatio * 100)} %`
        }
        value={readMemory}
      />
      {latest.memoryUsedRatio === null ? (
        <p className="text-muted-foreground text-xs">
          No memory limit declared — this service is bounded by the machine.
        </p>
      ) : null}
    </div>
  );
}
