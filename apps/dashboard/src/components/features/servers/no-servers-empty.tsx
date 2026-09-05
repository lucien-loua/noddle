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
          <HardDrivesIcon data-icon="inline-start" weight="regular" />
          Add a server
        </Button>
      </EmptyContent>
    </Empty>
  );
}
