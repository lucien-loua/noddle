import { ContainerLogs } from "@/components/features/logs/container-logs";

export const DatabaseLogs = ({
  databaseId,
  databaseName,
  generation,
}: {
  databaseId: string;
  databaseName: string;
  generation: string;
}) => (
  <ContainerLogs
    generation={generation}
    name={databaseName}
    streamUrl={`/api/database-logs/${databaseId}`}
  />
);
