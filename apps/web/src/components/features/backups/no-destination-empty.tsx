import { ArchiveIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";

import { IconStack } from "@/components/icon-stack";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function NoDestinationEmpty({ description }: { description: string }) {
  return (
    <Empty>
      <EmptyMedia>
        <IconStack>
          <ArchiveIcon className="size-5" />
        </IconStack>
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No S3 destination</EmptyTitle>
        <EmptyDescription>
          {description}{" "}
          <Link className="text-foreground underline" to="/destinations">
            S3 destinations
          </Link>
          .
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
