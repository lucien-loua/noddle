import {
  ArrowClockwiseIcon,
  PlugsIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { IconStack } from "@/components/icon-stack";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";

/**
 * A route that throws.
 *
 * Without this component, a loader exception renders the router's bare
 * error screen — which, in practice, means a blank page. The case had
 * already been documented for /audit, where it was fixed route by route;
 * it applied to the other nine, which all call a loader touching
 * Postgres.
 *
 * `reset` alone is NOT enough: it re-renders the error boundary, but the
 * loader's data remains the data that failed. `router.invalidate()` reruns
 * the loader, which is the only action that can recover from a transient
 * failure — a database unreachable for a second.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  const handleRetry = useCallback(async () => {
    await router.invalidate();
    reset();
  }, [reset, router]);

  return (
    <section className="h-svh p-4">
      <Empty className="h-full">
        <EmptyMedia>
          <IconStack>
            <WarningIcon className="size-5" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>This screen could not load</EmptyTitle>
          <EmptyDescription>
            {errorMessage(error, "Unknown error")}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={handleRetry} variant="outline">
            <ArrowClockwiseIcon data-icon="inline-start" weight="regular" />
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}

/** A URL that doesn't match any route. */
export function RouteNotFound() {
  return (
    <section className="h-svh p-4">
      <Empty className="h-svh">
        <EmptyMedia>
          <IconStack>
            <PlugsIcon className="size-5" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>
            This address does not match anything in Noddle.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            nativeButton={false}
            render={<Link to="/" />}
            variant="outline"
          >
            Back to dashboard
          </Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}

/**
 * A loader that takes a while.
 *
 * The router only shows it past `defaultPendingMs` (1s), and intent
 * preloading makes most navigations feel instant: in practice it only
 * shows up when something is actually slow, which is exactly the moment
 * when showing nothing would be misleading.
 */
export function RoutePending() {
  return (
    <div className="flex h-svh items-center justify-center" role="status">
      <Spinner />
      <span className="sr-only">Loading</span>
    </div>
  );
}
