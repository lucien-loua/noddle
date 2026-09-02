import { XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useState } from "react";

import { CopyButton } from "@/components/copyable-value";
import { ContainerLogs } from "@/components/features/logs/container-logs";
import { TabRail } from "@/components/tab-rail";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage, relativeTimeLong } from "@/lib/format";
import { queries } from "@/lib/queries";
import { ActiveTabPanel } from "@/lib/resource-detail/active-tab";
import { DETAIL_TAB_PANEL_CLASS } from "@/lib/resource-detail/constants";
import type { ContainerDetail, ContainerRow } from "@/server/containers";

const DRAWER_WIDTH = {
  "--drawer-content-width": "min(46rem, calc(100vw - 1rem))",
} as CSSProperties;

const KIND_LABEL: Record<ContainerRow["kind"], string> = {
  "control-plane": "Part of Noddle",
  swarm: "Swarm task",
  unmanaged: "Unmanaged",
};

function Fact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

function Section({
  children,
  count,
  title,
}: {
  children: ReactNode;
  count?: number;
  title: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 font-medium text-sm">
        {title}
        {count === undefined ? null : <Badge variant="outline">{count}</Badge>}
      </h3>
      {children}
    </section>
  );
}

function Nothing({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

function Ports({ ports }: { ports: ContainerDetail["ports"] }) {
  if (ports.length === 0) {
    return <Nothing>No port is exposed.</Nothing>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Container</TableHead>
          <TableHead>Published on the host</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ports.map((port) => (
          <TableRow key={`${port.containerPort}-${port.published ?? "none"}`}>
            <TableCell className="font-mono text-xs">
              {port.containerPort}
            </TableCell>
            <TableCell className="font-mono text-muted-foreground text-xs">
              {port.published ?? "not published"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Mounts({ mounts }: { mounts: ContainerDetail["mounts"] }) {
  if (mounts.length === 0) {
    return <Nothing>Nothing is mounted: this container keeps no data.</Nothing>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-20">Type</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Destination</TableHead>
          <TableHead className="w-16">Access</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mounts.map((mount) => (
          <TableRow key={`${mount.source}-${mount.destination}`}>
            <TableCell className="text-muted-foreground text-sm">
              {mount.type}
            </TableCell>
            <TableCell className="max-w-0 truncate font-mono text-xs">
              {mount.source}
            </TableCell>
            <TableCell className="max-w-0 truncate font-mono text-xs">
              {mount.destination}
            </TableCell>
            <TableCell className="text-sm">
              {mount.readWrite ? "read/write" : "read only"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Networks({ networks }: { networks: ContainerDetail["networks"] }) {
  if (networks.length === 0) {
    return <Nothing>Attached to no network.</Nothing>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Network</TableHead>
          <TableHead className="w-36">Address</TableHead>
          <TableHead className="hidden w-36 sm:table-cell">Gateway</TableHead>
          <TableHead className="hidden sm:table-cell">Aliases</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {networks.map((network) => (
          <TableRow key={network.name}>
            <TableCell className="max-w-0 truncate font-medium text-sm">
              {network.name}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {network.ipAddress || "—"}
            </TableCell>
            <TableCell className="hidden font-mono text-muted-foreground text-xs sm:table-cell">
              {network.gateway || "—"}
            </TableCell>
            <TableCell className="hidden max-w-0 truncate font-mono text-muted-foreground text-xs sm:table-cell">
              {network.aliases.length > 0 ? network.aliases.join(", ") : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Environment({ names }: { names: string[] }) {
  if (names.length === 0) {
    return <Nothing>No environment variable is set.</Nothing>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {names.map((name) => (
          <Badge key={name} variant="outline">
            <span className="font-mono">{name}</span>
          </Badge>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Names only. Values are never read off the machine — a service&apos;s own
        variables are on its Environment tab.
      </p>
    </div>
  );
}

function Details({
  detail,
  row,
}: {
  detail: ContainerDetail;
  row: ContainerRow;
}) {
  return (
    <div className="space-y-5 pb-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Fact label="Status">{row.status}</Fact>
        <Fact label="Kind">{KIND_LABEL[detail.kind]}</Fact>
        <Fact label="Server">{row.serverName}</Fact>
        <Fact label="Image">
          <span className="font-mono text-xs">{detail.image}</span>
        </Fact>
        <Fact label="Created">
          {detail.createdAt ? relativeTimeLong(detail.createdAt) : "—"}
        </Fact>
        <Fact label="Restart policy">{detail.restartPolicy}</Fact>
        {detail.health ? <Fact label="Health">{detail.health}</Fact> : null}
        <Fact label="Command">
          <span className="font-mono text-xs">{detail.command || "—"}</span>
        </Fact>
        <Fact label="Container ID">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-xs">
              {detail.id.slice(0, 12)}
            </span>
            <CopyButton label="container ID" value={detail.id} />
          </span>
        </Fact>
      </dl>

      <Section count={detail.ports.length} title="Ports">
        <Ports ports={detail.ports} />
      </Section>
      <Section count={detail.mounts.length} title="Mounts">
        <Mounts mounts={detail.mounts} />
      </Section>
      <Section count={detail.networks.length} title="Networks">
        <Networks networks={detail.networks} />
      </Section>
      <Section count={detail.envNames.length} title="Environment">
        <Environment names={detail.envNames} />
      </Section>
    </div>
  );
}

function Body({ row }: { row: ContainerRow }) {
  const detail = useQuery(queries.containerDetail(row.serverId, row.id));
  const [tab, setTab] = useState("details");
  const handleTab = useCallback((next: string | null) => {
    setTab(next ?? "details");
  }, []);

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <DrawerTitle className="min-w-0 truncate font-mono text-sm">
              {row.name}
            </DrawerTitle>
            <DrawerDescription>
              {KIND_LABEL[row.kind]} · {row.serverName}
            </DrawerDescription>
          </div>
          <DrawerClose
            aria-label="Close"
            className="-me-1 shrink-0 rounded-4xl p-1 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <XIcon className="size-4" weight="regular" />
          </DrawerClose>
        </div>
      </DrawerHeader>

      <Tabs
        className="flex min-h-0 flex-1 flex-col gap-3 p-4 pt-0"
        onValueChange={handleTab}
        value={tab}
      >
        <TabRail>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabRail>

        <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="details">
          <ActiveTabPanel active={tab} value="details">
            <DetailsPanel detail={detail.data} error={detail.error} row={row} />
          </ActiveTabPanel>
        </TabsContent>

        <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="logs">
          <ActiveTabPanel active={tab} value="logs">
            <ContainerLogs
              generation={row.status}
              name={row.name}
              streamUrl={`/api/container-logs/${row.serverId}/${row.id}`}
            />
          </ActiveTabPanel>
        </TabsContent>
      </Tabs>
    </>
  );
}

function DetailsPanel({
  detail,
  error,
  row,
}: {
  detail: ContainerDetail | undefined;
  error: Error | null;
  row: ContainerRow;
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {errorMessage(error, "could not inspect this container")}
        </AlertDescription>
      </Alert>
    );
  }
  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }
  return <Details detail={detail} row={row} />;
}

export function ContainerDrawer({
  onOpenChange,
  row,
}: {
  onOpenChange: (open: boolean) => void;
  row: ContainerRow | null;
}) {
  return (
    <Drawer
      onOpenChange={onOpenChange}
      open={row !== null}
      swipeDirection="right"
    >
      <DrawerContent style={DRAWER_WIDTH}>
        {row ? <Body row={row} /> : null}
      </DrawerContent>
    </Drawer>
  );
}
