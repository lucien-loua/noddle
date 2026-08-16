import { ChartLineIcon } from "@phosphor-icons/react";
import { areaY, type ChartPoint, defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts/tooltip";
import { scaleLinear } from "d3-scale";
import { useLayoutEffect, useRef, useState } from "react";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { byteSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MetricPoint, ServerSeries } from "@/server/metrics";

/** Beyond this, two samples are no longer considered consecutive: the line must break. */
const GAP_MS = 3 * 60 * 1000;

const HEIGHT = 64;

const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
});

export interface GappedPoint {
  t: number;
  v: number | null;
}

/**
 * The series, with an explicit `null` at each gap.
 *
 * This is THE mechanism that makes a gap visible. We don't hope that the
 * library will guess that points are missing: as soon as two samples are
 * more than `GAP_MS` apart, we insert a null value between them, and
 * `lineY` breaks the line at that point. Pure and exported function, so
 * testable without mounting a render.
 */
export function withGaps<T extends { sampledAt: string }>(
  points: T[],
  value: (p: T) => number
): GappedPoint[] {
  const out: GappedPoint[] = [];

  for (const p of points) {
    const t = Date.parse(p.sampledAt);
    const previous = out.at(-1);
    if (previous && previous.v !== null && t - previous.t > GAP_MS) {
      out.push({ t: (previous.t + t) / 2, v: null });
    }
    out.push({ t, v: value(p) });
  }
  return out;
}

const readX = (d: GappedPoint) => d.t;
const readY = (d: GappedPoint) => d.v;

/**
 * Measures the container's ACTUAL height, instead of a number picked in
 * advance: `Chart` only accepts a height in pixels, never a percentage, so
 * nothing in the library fills a flex container on its own. A compact
 * caller (a server's detail view, three stacked sparklines) has no flex
 * height to give: `min-h-16` then falls back to the old default. A caller
 * with plenty of room to spare (the Monitoring tab of a database or a
 * service, alone on its page) stretches the container to `flex-1` across
 * the full height; this hook measures THAT height and the card grows with
 * it — nothing to cap by hand.
 */
function useMeasuredHeight<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [measured, setMeasured] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive on useRef
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height && height > 0) {
        setMeasured(height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { measured, ref };
}

export function Sparkline<T extends { sampledAt: string }>({
  formatValue,
  label,
  max,
  points,
  shade,
  windowHours = 6,
  value,
}: {
  formatValue: (v: number) => string;
  label: string;
  max: number;
  points: T[];
  shade: string;
  windowHours?: 1 | 6 | 24;
  value: (p: T) => number;
}) {
  const { measured, ref } = useMeasuredHeight<HTMLDivElement>(HEIGHT);
  const data = withGaps(points, value);

  if (data.length === 0) {
    return <div className="h-full min-h-16 w-full" ref={ref} />;
  }

  const domainMax = Math.max(max, ...data.map((d) => d.v ?? 0));

  const definition = defineChart({
    guides: false,
    margin: 2,
    marks: [
      areaY(data, {
        fill: "currentColor",
        fillOpacity: 0.14,
        x: readX,
        y: readY,
      }),
      lineY(data, {
        stroke: "currentColor",
        strokeWidth: 1.5,
        x: readX,
        y: readY,
      }),
    ],
    tooltip: {
      format: (point: ChartPoint<GappedPoint>) =>
        point.datum.v === null
          ? "no data"
          : `${formatValue(point.datum.v)} · ${TIME.format(point.datum.t)}`,
      use: tooltip,
    },
    x: { axis: false, scale: scaleLinear },
    y: {
      axis: false,
      scale: scaleLinear().domain([0, domainMax || 1]),
    },
  });

  return (
    <div
      className={cn("h-full min-h-16 w-full overflow-hidden rounded-md", shade)}
      ref={ref}
    >
      <Chart
        ariaLabel={`${label} over the last ${windowHours} ${
          windowHours === 1 ? "hour" : "hours"
        }`}
        definition={definition}
        height={measured}
        initialWidth={640}
      />
    </div>
  );
}

export function MetricRow<T extends { sampledAt: string }>({
  formatValue,
  label,
  max,
  points,
  reading,
  shade,
  windowHours = 6,
  value,
}: {
  formatValue: (v: number) => string;
  label: string;
  max: number;
  points: T[];
  reading: string;
  shade: string;
  windowHours?: 1 | 6 | 24;
  value: (p: T) => number;
}) {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-muted-foreground text-xs">
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0 rounded-full bg-current", shade)}
          />
          {label}
        </span>
        <span className="font-medium text-sm tabular-nums">{reading}</span>
      </div>
      <div className="min-h-0 flex-1">
        <Sparkline
          formatValue={formatValue}
          label={label}
          max={max}
          points={points}
          shade={shade}
          value={value}
          windowHours={windowHours}
        />
      </div>
    </div>
  );
}

const pct = (ratio: number) => `${Math.round(ratio * 100)} %`;
const formatLoad = (v: number) => v.toFixed(2);
const formatIo = (v: number) => (v === 0 ? "0 B" : byteSize(v, 1000));

const readLoad = (p: MetricPoint) => p.cpuLoad1;
const readMemory = (p: MetricPoint) => p.memoryUsedRatio;
const readDisk = (p: MetricPoint) => p.diskUsedRatio;
const readBlockIo = (p: MetricPoint) => p.blockReadBytes + p.blockWriteBytes;
const readNetworkIo = (p: MetricPoint) => p.networkInBytes + p.networkOutBytes;

/**
 * The resources of ONE machine.
 *
 * A single one, no longer a list: this card used to live under the servers
 * list and rendered one per machine, which required carrying the server's
 * NAME to say which one it referred to. Since it now lives on the
 * machine's own page, that name is already the page title — and the empty
 * state "no machine" had become both unreachable and wrong, since we're
 * looking at exactly one.
 */
export function ResourceGraphs({
  series,
  windowHours = 6,
}: {
  series: ServerSeries | null;
  windowHours?: 1 | 6 | 24;
}) {
  if (!series) {
    return (
      <Empty className="border">
        <EmptyMedia>
          <IconStack>
            <ChartLineIcon className="size-5" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No samples yet</EmptyTitle>
          <EmptyDescription>
            Resources are sampled every minute on every connected server.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Frame stacked variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <FrameTitle className="flex items-center gap-2">
          Live resources
          <Badge variant="outline">{series.cpuCount} cores</Badge>
        </FrameTitle>
        <ServerFreshness latest={series.latest} />
      </FrameHeader>

      {series.latest ? (
        <>
          <FramePanel>
            <MetricRow
              formatValue={formatLoad}
              label="Load"
              max={series.cpuCount}
              points={series.points}
              reading={series.latest.cpuLoad1.toFixed(2)}
              shade="text-chart-1"
              value={readLoad}
              windowHours={windowHours}
            />
          </FramePanel>
          <FramePanel>
            <MetricRow
              formatValue={pct}
              label="Memory"
              max={1}
              points={series.points}
              reading={pct(series.latest.memoryUsedRatio)}
              shade="text-chart-2"
              value={readMemory}
              windowHours={windowHours}
            />
          </FramePanel>
          <FramePanel>
            <MetricRow
              formatValue={pct}
              label="Disk"
              max={1}
              points={series.points}
              reading={pct(series.latest.diskUsedRatio)}
              shade="text-chart-3"
              value={readDisk}
              windowHours={windowHours}
            />
          </FramePanel>
          <FramePanel>
            <MetricRow
              formatValue={formatIo}
              label="Block I/O"
              max={Math.max(...series.points.map((p) => readBlockIo(p)))}
              points={series.points}
              reading={`Read: ${formatIo(series.latest.blockReadBytes)} / Write: ${formatIo(series.latest.blockWriteBytes)}`}
              shade="text-chart-4"
              value={readBlockIo}
              windowHours={windowHours}
            />
          </FramePanel>
          <FramePanel>
            <MetricRow
              formatValue={formatIo}
              label="Network I/O"
              max={Math.max(...series.points.map((p) => readNetworkIo(p)))}
              points={series.points}
              reading={`In: ${formatIo(series.latest.networkInBytes)} / Out: ${formatIo(series.latest.networkOutBytes)}`}
              shade="text-chart-2"
              value={readNetworkIo}
              windowHours={windowHours}
            />
          </FramePanel>
        </>
      ) : (
        <FramePanel>
          <FrameDescription>
            No samples in the last {windowHours}{" "}
            {windowHours === 1 ? "hour" : "hours"}.
          </FrameDescription>
        </FramePanel>
      )}
    </Frame>
  );
}

/**
 * How long ago the last reading was.
 *
 * Displayed because a curve alone doesn't say whether it's up to date: a
 * machine unreachable for an hour shows exactly the same shape as a quiet
 * machine, except that its own stops. This is where we say it in words.
 */
function ServerFreshness({ latest }: { latest: MetricPoint | null }) {
  if (!latest) {
    return <Badge variant="destructive">no samples</Badge>;
  }
  const age = Date.now() - Date.parse(latest.sampledAt);
  if (age > GAP_MS) {
    return (
      <Badge variant="destructive">
        frozen <RelativeTime iso={latest.sampledAt} />
      </Badge>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      sampled <RelativeTime iso={latest.sampledAt} />
    </span>
  );
}
