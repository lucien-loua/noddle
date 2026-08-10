import { DEFAULT_DATABASE_IMAGE } from "@noddle/shared/database-engines";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import type { DatabaseRow } from "@/server/databases";

function Fact({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate font-mono text-sm">{children}</dd>
    </div>
  );
}

export function DatabaseConfiguration({ database }: { database: DatabaseRow }) {
  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Configuration</FrameTitle>
        <FrameDescription>
          Fixed at creation, so an existing volume never wakes up under a
          different engine version or a second container.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
          <Fact label="Docker image">
            {database.image ?? DEFAULT_DATABASE_IMAGE[database.engine]}
          </Fact>
          <Fact label="Replicas">1</Fact>
          <Fact label="Volume">{database.swarmName}</Fact>
        </dl>
      </FramePanel>
    </Frame>
  );
}
