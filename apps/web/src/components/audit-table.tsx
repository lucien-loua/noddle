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

export function AuditTable({ entries }: { entries: AuditRow[] }) {
  if (entries.length === 0) {
    return (
      <Frame className="flex h-full min-h-0 flex-col" variant="ghost">
        <FramePanel className="flex min-h-0 flex-1 flex-col">
          <Empty className="min-h-0 flex-1 border-0">
            <EmptyHeader>
              <EmptyMedia>
                <IconStack>
                  <ScrollIcon className="size-5" />
                </IconStack>
              </EmptyMedia>
              <EmptyTitle>Nothing recorded yet</EmptyTitle>
              <EmptyDescription>
                Every attempt to change something, allowed or denied, is
                recorded here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </FramePanel>
      </Frame>
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
