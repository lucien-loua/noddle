import { ScrollIcon } from "@phosphor-icons/react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditRow } from "@/server/audit";

/**
 * The audit log.
 *
 * **"Attempted", never "did".** The row is written by the permission guard,
 * so BEFORE the action: it proves an attempt took place and was authorized,
 * not that the action succeeded. Writing "deployed" here would be a claim
 * the log cannot back up — exactly the kind of screen that lies about the
 * real state, which this product exists to avoid.
 */
export function AuditTable({ entries }: { entries: AuditRow[] }) {
  if (entries.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyMedia>
          <IconStack>
            <ScrollIcon className="size-5" weight="duotone" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Nothing recorded yet</EmptyTitle>
          <EmptyDescription>
            Every attempt to change something — allowed or denied — is recorded
            here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Audit log</FrameTitle>
        <FrameDescription>
          Every attempt to change something, allowed or denied. Recorded when
          the request is authorised, so an entry means it was <em>attempted</em>
          , not that it finished.
        </FrameDescription>
      </FrameHeader>
      <FramePanel className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="w-28">Result</TableHead>
              <TableHead className="hidden w-36 md:table-cell">From</TableHead>
              <TableHead className="w-32">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                {/* Two LINES, not two pieces side by side. A margin is
                    layout, not text: the accessibility tree concatenates
                    sibling nodes without a separator, and the cell used to
                    announce "owner@noddle.testowner". Measured in the
                    browser — invisible to the eye, unreadable to a screen
                    reader. */}
                <TableCell className="font-medium">
                  <span className="block">{e.actorEmail}</span>
                  {e.role ? (
                    <span className="block text-muted-foreground text-xs">
                      {e.role}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {e.action} · {e.resource}
                </TableCell>
                <TableCell>
                  {/* A denial isn't a failure — it's the product doing its
                      job. `outline` rather than `destructive`, which would
                      mean "something is broken". */}
                  <Badge
                    variant={e.outcome === "denied" ? "outline" : "secondary"}
                  >
                    {e.outcome === "denied" ? "Denied" : "Allowed"}
                  </Badge>
                </TableCell>
                <TableCell className="hidden font-mono text-muted-foreground text-xs md:table-cell">
                  {e.ipAddress ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  <RelativeTime iso={e.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </FramePanel>
    </Frame>
  );
}
