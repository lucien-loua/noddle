import { MetricRow } from "@/components/resource-graphs";
import { Badge } from "@/components/ui/badge";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { byteSize } from "@/lib/format";
import type { ServicePoint, ServiceSeries } from "@/server/metrics";

/** The CPU axis cap when the container stays under 100% of one core. */
const CPU_FLOOR = 100;

const formatCpu = (v: number) => `${v.toFixed(1)} %`;
const formatMemory = (v: number) => byteSize(v);

const readCpu = (p: ServicePoint) => p.cpuPercent;
const readMemory = (p: ServicePoint) => p.memoryUsedBytes;

interface ResourcePanelProps {
  /** What's said when the window is empty. A gap means "we weren't
   *  watching", so the sentence must say WHEN we watch. */
  emptyNote: string;
  series: ServiceSeries | undefined;
  /** What's said when no memory limit is declared. */
  unboundedNote: string;
}

export function ResourcePanel({
  emptyNote,
  series,
  unboundedNote,
}: ResourcePanelProps) {
  if (!series || series.points.length === 0) {
    return <p className="text-muted-foreground text-xs">{emptyNote}</p>;
  }

  const { latest, points, restarts } = series;
  if (!latest) {
    return null;
  }
  const cpuMax = Math.max(CPU_FLOOR, ...points.map(readCpu));
  const memMax = Math.max(...points.map(readMemory));

  return (
    <Frame className="h-full" stacked variant="ghost">
      <FrameHeader className="flex-row items-center gap-2">
        <FrameTitle>Last six hours</FrameTitle>
        {restarts > 1 ? (
          <Badge
            title="The series spans several successive containers: a break may be a redeploy, not a change in behaviour."
            variant="outline"
          >
            {restarts} containers over the period
          </Badge>
        ) : null}
      </FrameHeader>

      <FramePanel className="flex-1">
        <MetricRow
          formatValue={formatCpu}
          label="CPU"
          max={cpuMax}
          points={points}
          reading={`${latest.cpuPercent.toFixed(1)} %`}
          shade="text-chart-1"
          value={readCpu}
        />
      </FramePanel>

      <FramePanel className="flex-1">
        <MetricRow
          formatValue={formatMemory}
          label="Memory"
          max={memMax}
          points={points}
          reading={
            latest.memoryUsedRatio === null
              ? byteSize(latest.memoryUsedBytes)
              : `${Math.round(latest.memoryUsedRatio * 100)} %`
          }
          shade="text-chart-2"
          value={readMemory}
        />
        {latest.memoryUsedRatio === null ? (
          <p className="mt-2 text-muted-foreground text-xs">{unboundedNote}</p>
        ) : null}
      </FramePanel>
    </Frame>
  );
}
