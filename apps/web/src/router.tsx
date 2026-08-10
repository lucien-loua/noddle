import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import {
  RouteError,
  RouteNotFound,
  RoutePending,
} from "@/components/route-states";
import { routeTree } from "@/routeTree.gen";

export function getRouter() {
  return createTanStackRouter({
    // All three set HERE, once, and never route by route: it's the single
    // point of passage, so a route added tomorrow inherits them. A route
    // can always override its own — /audit does, because a permission
    // denial is not a failure and isn't stated the same way.
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
