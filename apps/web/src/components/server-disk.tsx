import { HardDriveIcon } from "@phosphor-icons/react";
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
import { Progress } from "@/components/ui/progress";
import { byteSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DiskCategoryKey, ServerDisk } from "@/server/metrics";

/**
 * Beyond this, the reading no longer reflects the machine.
 *
 * Two and a half times the collection cadence (ten minutes), and
 * deliberately NOT the sparklines' constant: those are sampled every
 * minute and break their line at three. Reusing their threshold here would
 * permanently show "stale" on a perfectly up-to-date reading.
 */
const STALE_MS = 25 * 60 * 1000;

const LABELS: Record<DiskCategoryKey, string> = {
  buildCache: "Build cache",
  containers: "Containers",
  images: "Images",
  volumes: "Volumes",
};

/**
 * One HUE per category, taken from the preset's categorical palette.
 *
 * Four shades of the same gray were only distinguishable by position, and
 * in practice that isn't enough: on an 8px bar, `foreground/45` and
 * `foreground/70` read as a single part. The legend then became the ONLY
 * way to read the bar, which makes it decorative — yet it exists to be
 * read at a glance.
 *
 * The `--chart-*` tokens were themselves at chroma 0 in the preset, so
 * using them as-is would have changed nothing; they now carry an actual
 * hue (see `styles.css`).
 *
 * In `text-*` rather than `bg-*`: the hue is set on the segment, and both
 * the dot and the bar pick it up via `bg-current`. A single table for
 * both — Tailwind doesn't accept a computed class name, so the variant
 * that targets the indicator can't carry the hue itself.
 */
const SHADES: Record<DiskCategoryKey, string> = {
  buildCache: "text-chart-4",
  containers: "text-chart-2",
  images: "text-chart-1",
  volumes: "text-chart-3",
};

/**
 * What needs to be told to `Progress` so it renders ONE PART of a stacked
 * bar rather than a whole bar.
 *
 * The preset's component takes a SINGLE value: its root carries one
 * `value`, and our wrapper hooks exactly one track/indicator pair onto it.
 * Four parts of the same total therefore can't be expressed in a single
 * root — hence one root PER category, sized to its own share, filled to
 * 100%. It's the width that carries the information, never the value.
 *
 * The track loses its background and its radius: the gray background and
 * rounded corners belong to the container that gathers the four, not to
 * each one individually. And `transition-none` because the preset's
 * indicator animates its width — a bar that fills in on every render where
 * the previous one displayed all at once.
 */
const SEGMENT =
  "h-full gap-0 [&_[data-slot=progress-track]]:h-full [&_[data-slot=progress-track]]:rounded-none [&_[data-slot=progress-track]]:bg-transparent [&_[data-slot=progress-indicator]]:bg-current [&_[data-slot=progress-indicator]]:transition-none";

/**
 * Bytes, in the SAME convention as `docker system df`.
 *
 * Base 1000: that's what the CLI displays (as measured — the API says
 * 3,574,994,286, the CLI says "3.575GB"). In base 1024 the same reading
 * would read "3.3 GiB", and this screen would be the only one in the
 * product to contradict the command it reflects.
 *
 * `byteSize` renders "—" at zero, which reads as "unknown". Here zero is a
 * MEASUREMENT: an empty build cache is a fact, not the absence of a
 * reading.
 */
function size(bytes: number): string {
  return bytes === 0 ? "0 B" : byteSize(bytes, 1000);
}

function Freshness({ sampledAt }: { sampledAt: string }) {
  if (Date.now() - Date.parse(sampledAt) > STALE_MS) {
    return (
      <Badge variant="destructive">
        stale <RelativeTime iso={sampledAt} />
      </Badge>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      read <RelativeTime iso={sampledAt} />
    </span>
  );
}

export function ServerDiskUsage({
  children,
  disk,
}: {
  children?: React.ReactNode;
  disk: ServerDisk | null;
}) {
  if (!disk) {
    return (
      <Frame stacked variant="ghost">
        <FramePanel>
          <Empty>
            <EmptyMedia>
              <IconStack>
                <HardDriveIcon className="size-5" weight="duotone" />
              </IconStack>
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No reading yet</EmptyTitle>
              <EmptyDescription>
                Docker's disk breakdown is read every ten minutes on every
                connected server.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </FramePanel>
        {children}
      </Frame>
    );
  }

  const total = disk.categories.reduce((sum, c) => sum + c.bytes, 0);
  const reclaimable = disk.categories.reduce(
    (sum, c) => sum + c.reclaimableBytes,
    0
  );

  return (
    <Frame stacked variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <FrameTitle className="flex items-center gap-2">
          Docker disk usage
          <Badge variant="outline">{size(total)}</Badge>
        </FrameTitle>
        <Freshness sampledAt={disk.sampledAt} />
      </FrameHeader>

      <FramePanel className="space-y-3">
        <div
          aria-hidden="true"
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          {disk.categories.map((c) =>
            c.bytes > 0 ? (
              <Progress
                aria-hidden="true"
                className={cn(SEGMENT, SHADES[c.key])}
                key={c.key}
                locale="en-US"
                style={{ width: `${(c.bytes / Math.max(total, 1)) * 100}%` }}
                value={100}
              />
            ) : null
          )}
        </div>

        <dl className="space-y-1.5">
          {disk.categories.map((c) => (
            <div className="flex items-center gap-3 text-xs" key={c.key}>
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full bg-current",
                  SHADES[c.key]
                )}
              />
              <dt className="min-w-0 flex-1 truncate text-muted-foreground">
                {LABELS[c.key]}
                <span className="ms-1.5 text-muted-foreground/60">
                  ({c.count})
                </span>
              </dt>
              <dd className="w-28 shrink-0 text-end text-muted-foreground tabular-nums">
                {size(c.reclaimableBytes)} free
              </dd>
              <dd className="w-20 shrink-0 text-end tabular-nums">
                {size(c.bytes)}
              </dd>
            </div>
          ))}
        </dl>

        <FrameDescription>
          {size(reclaimable)} of {size(total)} could be reclaimed. Once a day,
          Noddle prunes stopped containers, images no container uses, and build
          cache untouched for a week; unreferenced registry layers go every
          hour. Volumes are never pruned — a stopped database still owns its
          data.
        </FrameDescription>
      </FramePanel>
      {children}
    </Frame>
  );
}
