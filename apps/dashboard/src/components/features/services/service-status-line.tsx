import { StatusIndicator } from "@/components/ui/status";
import type { Tone } from "@/lib/format";
import type { ServiceRow } from "@/server/dashboard";

const BUILD_METHOD_LABEL: Record<ServiceRow["buildMethod"], string> = {
  dockerfile: "Dockerfile",
  image: "Image",
  railpack: "Railpack",
};

export function ServiceStatusLine({
  service,
  status,
}: {
  service: ServiceRow;
  status: { label: string; tone: Tone };
}) {
  return (
    <p className="flex min-w-0 items-center gap-2 truncate text-muted-foreground text-sm">
      <StatusIndicator tone={status.tone} />
      <span className="shrink-0">{status.label}</span>
      {service.watching ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0">watching</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span className="shrink-0">
        {BUILD_METHOD_LABEL[service.buildMethod]}
      </span>
      <span aria-hidden>·</span>
      <span className="truncate">{service.serverName}</span>
    </p>
  );
}
