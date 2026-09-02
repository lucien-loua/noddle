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
import { Frame, FramePanel } from "@/components/ui/frame";

export function NoDestinationEmpty({ description }: { description: string }) {
  return (
    <Frame className="flex h-full min-h-0 flex-1 flex-col" variant="ghost">
      <FramePanel className="flex min-h-0 flex-1 flex-col">
        <Empty className="min-h-0 flex-1 border-0">
          <EmptyHeader>
            <EmptyMedia>
              <IconStack>
                <ArchiveIcon className="size-5" />
              </IconStack>
            </EmptyMedia>
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
      </FramePanel>
    </Frame>
  );
}
