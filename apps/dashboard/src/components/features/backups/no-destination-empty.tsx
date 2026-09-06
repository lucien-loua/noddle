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
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { cn } from "@/lib/utils";

export function NoDestinationEmpty({
  description,
  heading,
  intro,
}: {
  description: string;
  heading?: string;
  intro?: string;
}) {
  return (
    <Frame
      className={cn(!heading && "flex h-full min-h-0 flex-1 flex-col")}
      variant="ghost"
    >
      {heading ? (
        <FrameHeader>
          <FrameTitle>{heading}</FrameTitle>
          {intro ? <FrameDescription>{intro}</FrameDescription> : null}
        </FrameHeader>
      ) : null}
      <FramePanel className={cn(!heading && "flex min-h-0 flex-1 flex-col")}>
        <Empty className={cn("border-0", !heading && "min-h-0 flex-1")}>
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
