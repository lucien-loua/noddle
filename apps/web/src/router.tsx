import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import {
  RouteError,
  RouteNotFound,
  RoutePending,
} from "@/components/route-states";
import { routeTree } from "@/routeTree.gen";

export function getRouter() {
  return createTanStackRouter({
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    defaultPendingComponent: RoutePending,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    routeTree,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
