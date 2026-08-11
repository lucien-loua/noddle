import { DatabaseClusterSettings } from "@/components/features/database/database-cluster-settings";
import { DatabaseConfiguration } from "@/components/features/database/database-configuration";
import { DatabaseDangerZone } from "@/components/features/database/database-danger-zone";
import { DatabaseResourceLimits } from "@/components/features/database/database-resource-limits";
import { DatabaseVolumes } from "@/components/features/database/database-volumes";
import type { DatabaseRow } from "@/server/databases";

export function DatabaseAdvanced({
  canEdit,
  database,
}: {
  /** `database: create` for Configuration/Resources, `database: delete` for
   *  Rebuild — checked separately by each server function. A single flag
   *  here because the caller only has one role to pass, and both
   *  permissions are granted together to `admin`/`owner` anyway. */
  canEdit: boolean;
  database: DatabaseRow;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DatabaseConfiguration canEdit={canEdit} database={database} />
      <DatabaseClusterSettings
        canEdit={canEdit}
        databaseId={database.id}
        replicas={database.replicas}
        swarmSettings={database.swarmSettings}
      />
      <DatabaseVolumes
        canEdit={canEdit}
        databaseId={database.id}
        engine={database.engine}
        extraMounts={database.extraMounts}
        swarmName={database.swarmName}
        volumePath={database.volumePath}
      />
      <DatabaseResourceLimits
        canEdit={canEdit}
        cpuLimitNanos={database.cpuLimitNanos}
        cpuReservationNanos={database.cpuReservationNanos}
        databaseId={database.id}
        memoryLimitBytes={database.memoryLimitBytes}
        memoryReservationBytes={database.memoryReservationBytes}
      />
      {canEdit ? (
        <DatabaseDangerZone
          databaseId={database.id}
          databaseName={database.name}
        />
      ) : null}
    </div>
  );
}
