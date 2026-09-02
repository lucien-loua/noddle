import {
  ArrowClockwiseIcon,
  HouseIcon,
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
            {errorMessage(error, "No further detail was returned.")}
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
            <HouseIcon data-icon="inline-start" weight="regular" />
            Back to dashboard
          </Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}

export function RoutePending() {
  return (
    <output className="flex h-svh items-center justify-center">
      <Spinner />
      <span className="sr-only">Loading</span>
    </output>
  );
}
