import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { RelativeTime } from "@/components/relative-time";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { shortSha } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import type { ServiceRow } from "@/server/dashboard";

import { ServiceRegistry } from "./service-registry";

function Fact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

export function ServiceFacts({
  role,
  runningOn,
  service,
}: {
  role: RoleName | null;
  runningOn: string | null;
  service: ServiceRow;
}) {
  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Details</FrameTitle>
        <FrameDescription>
          Where this application runs and which commit is currently served.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Fact label="Domains">
            {service.domains.length > 0 ? (
              <ul className="space-y-1">
                {service.domains.map((d) => {
                  const scheme = d.https ? "https" : "http";
                  return (
                    <li key={d.id}>
                      <a
                        className="flex items-center gap-1 underline underline-offset-4 hover:text-foreground"
                        href={`${scheme}://${d.host}`}
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        <span className="min-w-0 truncate">{d.host}</span>
                        <ArrowSquareOutIcon
                          className="size-3.5 shrink-0"
                          weight="regular"
                        />
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="text-muted-foreground">Not reachable</span>
            )}
          </Fact>

          <Fact label="Commit">
            {service.lastDeployment?.commitSha ? (
              <span className="font-mono">
                {shortSha(service.lastDeployment.commitSha)}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>

          <Fact label="Last deploy">
            {service.lastDeployment ? (
              <RelativeTime iso={service.lastDeployment.createdAt} />
            ) : (
              <span className="text-muted-foreground">Never</span>
            )}
          </Fact>

          <Fact label={runningOn ? "Running on" : "Server"}>
            {runningOn && runningOn !== service.serverName
              ? `${runningOn} (built on ${service.serverName})`
              : service.serverName}
          </Fact>

          <Fact label="Registry">
            <ServiceRegistry
              registryId={service.registryId}
              role={role}
              serviceId={service.id}
            />
          </Fact>
        </dl>
      </FramePanel>
    </Frame>
  );
}
