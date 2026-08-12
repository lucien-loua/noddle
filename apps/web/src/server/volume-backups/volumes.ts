import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSession } from "@/lib/session.server";

export interface ServiceVolumeRow {
  mountPath: string;
  volumeName: string;
}

export const listServiceVolumes = createServerFn({ method: "GET" })
  .validator(z.object({ serviceId: z.uuid() }))
  .handler(async ({ data }): Promise<ServiceVolumeRow[]> => {
    await requireSession();
    const { loadServiceVolumeMounts } = await import("./volumes.server");
    return await loadServiceVolumeMounts(data.serviceId);
  });
