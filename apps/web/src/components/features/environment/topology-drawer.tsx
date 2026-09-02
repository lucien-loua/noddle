"use client";

import { ArrowRightIcon, GlobeIcon, XIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { lazy, Suspense, useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Frame, FramePanel } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import type { Scope } from "@/server/dashboard";

const ContainerLogs = lazy(() =>
  import("@/components/features/logs/container-logs").then((m) => ({
    default: m.ContainerLogs,
  }))
);

export type TopologyPanel =
  | { kind: "logs"; resource: "database" | "service"; id: string; name: string }
  | { kind: "routing" };

const DRAWER_WIDTH = {
  "--drawer-content-width": "min(46rem, calc(100vw - 1rem))",
} as CSSProperties;

interface Route {
  cert: string | null;
  host: string;
  key: string;
  port: number | null;
  scheme: string | null;
  to: string;
  url: string | null;
}

function certLabel(domain: { certificateType: string; https: boolean }) {
  if (!domain.https) {
    return null;
  }
  return domain.certificateType === "letsencrypt" ? "Let's Encrypt" : "Manual";
}

function buildRoutes(scope: Scope): Route[] {
  const routes: Route[] = [];

  for (const service of scope.services) {
    for (const domain of service.domains) {
      const scheme = domain.https ? "https" : "http";
      routes.push({
        cert: certLabel(domain),
        host: `${domain.host}${domain.path === "/" ? "" : domain.path}`,
        key: domain.id,
        port: service.port,
        scheme: scheme.toUpperCase(),
        to: service.name,
        url: `${scheme}://${domain.host}${domain.path}`,
      });
    }
  }

  for (const stack of scope.stacks) {
    if (stack.domain) {
      routes.push({
        cert: null,
        host: stack.domain,
        key: stack.id,
        port: stack.port,
        scheme: null,
        to: stack.name,
        url: null,
      });
    }
  }

  return routes;
}

function RouteRow({ route }: { route: Route }) {
  return (
    <FramePanel className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        {route.url ? (
          <a
            className="min-w-0 truncate font-medium text-sm hover:underline"
            href={route.url}
            rel="noopener"
            target="_blank"
          >
            {route.host}
          </a>
        ) : (
          <span className="min-w-0 truncate font-medium text-sm">
            {route.host}
          </span>
        )}
        {route.scheme ? (
          <Badge className="shrink-0" variant="outline">
            {route.scheme}
          </Badge>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <ArrowRightIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{route.to}</span>
        {route.port === null ? null : (
          <span className="shrink-0 tabular-nums">:{route.port}</span>
        )}
        {route.cert ? (
          <span className="ms-auto shrink-0 truncate">{route.cert}</span>
        ) : null}
      </div>
    </FramePanel>
  );
}

function RoutingBody({ scope }: { scope: Scope }) {
  const routes = useMemo(() => buildRoutes(scope), [scope]);

  if (routes.length === 0) {
    return (
      <Empty className="flex-1 border-0">
        <EmptyHeader>
          <EmptyTitle>Nothing is public</EmptyTitle>
          <EmptyDescription>
            Add a domain to a service and Traefik will route it from here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Frame variant="ghost">
        {routes.map((route) => (
          <RouteRow key={route.key} route={route} />
        ))}
      </Frame>
    </div>
  );
}

function panelTitle(panel: TopologyPanel) {
  return panel.kind === "routing" ? "Routing" : panel.name;
}

function panelDescription(panel: TopologyPanel) {
  return panel.kind === "routing"
    ? "What the internet reaches, and where Traefik sends it."
    : "Live container output.";
}

export function TopologyDrawer({
  generation,
  onOpenChange,
  panel,
  scope,
}: {
  generation: string;
  onOpenChange: (open: boolean) => void;
  panel: TopologyPanel | null;
  scope: Scope;
}) {
  return (
    <Drawer
      onOpenChange={onOpenChange}
      open={panel !== null}
      swipeDirection="right"
    >
      <DrawerContent style={DRAWER_WIDTH}>
        {panel ? (
          <>
            <DrawerHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <DrawerTitle className="flex min-w-0 items-center gap-2">
                    {panel.kind === "routing" ? (
                      <GlobeIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    ) : null}
                    <span className="truncate">{panelTitle(panel)}</span>
                  </DrawerTitle>
                  <DrawerDescription>
                    {panelDescription(panel)}
                  </DrawerDescription>
                </div>
                <DrawerClose
                  aria-label="Close"
                  className="-me-1 shrink-0 rounded-4xl p-1 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <XIcon className="size-4" />
                </DrawerClose>
              </div>
            </DrawerHeader>

            <div className="flex min-h-0 flex-1 flex-col p-4">
              {panel.kind === "routing" ? (
                <RoutingBody scope={scope} />
              ) : (
                <Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center">
                      <Spinner className="size-5" />
                    </div>
                  }
                >
                  <ContainerLogs
                    generation={generation}
                    name={panel.name}
                    streamUrl={
                      panel.resource === "database"
                        ? `/api/database-logs/${panel.id}`
                        : `/api/service-logs/${panel.id}`
                    }
                  />
                </Suspense>
              )}
            </div>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
