import type { ReactNode } from "react";

import { MetricRow } from "@/components/resource-graphs";
import { Badge } from "@/components/ui/badge";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { byteSize } from "@/lib/format";
import type { ServicePoint, ServiceSeries } from "@/server/metrics";

/** The CPU axis cap when the container stays under 100% of one core. */
const CPU_FLOOR = 100;

const formatCpu = (v: number) => `${v.toFixed(1)} %`;
const formatMemory = (v: number) => byteSize(v);
const formatIo = (v: number) => (v === 0 ? "0 B" : byteSize(v, 1000));

const readCpu = (p: ServicePoint) => p.cpuPercent;
const readMemory = (p: ServicePoint) => p.memoryUsedBytes;
const readBlockIo = (p: ServicePoint) => p.blockReadBytes + p.blockWriteBytes;
const readNetworkIo = (p: ServicePoint) => p.networkInBytes + p.networkOutBytes;

interface ResourcePanelProps {
  /** What's said when the window is empty. A gap means "we weren't
   *  watching", so the sentence must say WHEN we watch. */
  emptyNote: string;
  /** Optional controls rendered on the right side of the frame header. */
  headerControls?: ReactNode;
  series: ServiceSeries | undefined;
  /** What's said when no memory limit is declared. */
  unboundedNote: string;
  /** Metrics window in hours. Defaults to 6 to match historical behaviour. */
  windowHours?: 1 | 6 | 24;
}

export function ResourcePanel({
  emptyNote,
  series,
  unboundedNote,
  windowHours = 6,
  headerControls,
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
  const blockIoMax = Math.max(...points.map(readBlockIo));
  const networkIoMax = Math.max(...points.map(readNetworkIo));

  return (
    <Frame className="h-full" stacked variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FrameTitle>Resources</FrameTitle>
          {restarts > 1 ? (
            <Badge
              title="The series spans several successive containers: a break may be a redeploy, not a change in behaviour."
              variant="outline"
            >
              {restarts} containers over the period
            </Badge>
          ) : null}
        </div>
        {headerControls ? <div className="shrink-0">{headerControls}</div> : null}
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
          windowHours={windowHours}
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
          windowHours={windowHours}
        />
        {latest.memoryUsedRatio === null ? (
          <p className="mt-2 text-muted-foreground text-xs">{unboundedNote}</p>
        ) : null}
      </FramePanel>

      <FramePanel className="flex-1">
        <MetricRow
          formatValue={formatIo}
          label="Block I/O"
          max={blockIoMax}
          points={points}
          reading={`Read: ${formatIo(latest.blockReadBytes)} / Write: ${formatIo(latest.blockWriteBytes)}`}
          shade="text-chart-4"
          value={readBlockIo}
          windowHours={windowHours}
        />
      </FramePanel>

      <FramePanel className="flex-1">
        <MetricRow
          formatValue={formatIo}
          label="Network I/O"
          max={networkIoMax}
          points={points}
          reading={`In: ${formatIo(latest.networkInBytes)} / Out: ${formatIo(latest.networkOutBytes)}`}
          shade="text-chart-2"
          value={readNetworkIo}
          windowHours={windowHours}
        />
      </FramePanel>
    </Frame>
  );
}
