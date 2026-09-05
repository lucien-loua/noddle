import { ContainerLogs } from "@/components/features/logs/container-logs";

export function DatabaseLogs({
  databaseId,
  databaseName,
  generation,
}: {
  databaseId: string;
  databaseName: string;
  generation: string;
}) {
  return (
    <ContainerLogs
      generation={generation}
      name={databaseName}
      streamUrl={`/api/database-logs/${databaseId}`}
    />
  );
}
