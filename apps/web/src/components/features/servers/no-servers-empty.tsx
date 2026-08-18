import { HardDrivesIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * Zero servers, said where it blocks — the create dialogs.
 *
 * They each rendered a `destructive` alert, which is the register of a
 * failure: the same files use it, correctly, for a submission that failed.
 * An empty fleet is not a failure, and the alert named the missing thing
 * without offering the screen that adds it.
 */
export function NoServersEmpty({ description }: { description: string }) {
  return (
    <Empty className="p-8">
      <EmptyMedia variant="icon">
        <HardDrivesIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No servers yet</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          nativeButton={false}
          render={<Link to="/servers" />}
          variant="outline"
        >
          Add a server
        </Button>
      </EmptyContent>
    </Empty>
  );
}
