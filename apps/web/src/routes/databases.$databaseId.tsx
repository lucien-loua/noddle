// Le détail d'une base : ses sauvegardes, sur SA page.
//
// Pas d'onglets ici, contrairement à un service : une base n'a qu'un seul
// sujet. Un rail d'un seul élément serait du décor.
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BackupPanel, RestoreDialog } from "@/components/backup-panel";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { serviceLabel } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { type BackupRow, triggerRestore } from "@/server/backups";
import { getDatabaseDashboard } from "@/server/databases";

const ENGINE_LABEL: Record<string, string> = {
  postgres: "PostgreSQL",
  redis: "Redis",
};

export const Route = createFileRoute("/databases/$databaseId")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: DatabaseDetail,
  loader: async ({ context, params }) => {
    const databases = await getDatabaseDashboard();
    const database = databases.find((d) => d.id === params.databaseId);
    if (!database) {
      throw notFound();
    }
    return { database, email: context.email, role: context.role };
  },
});

function DatabaseDetail() {
  const { database, email, role } = Route.useLoaderData();

  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canCreateBackup = useCan(known, "backup", "create");
  const canRestoreBackup = useCan(known, "backup", "restore");

  const [target, setTarget] = useState<BackupRow | null>(null);
  const restore = useMutation({
    mutationFn: (confirmName: string) =>
      triggerRestore({
        data: {
          backupId: target?.id ?? "",
          confirmName,
          databaseId: database.id,
        },
      }),
    onSuccess: () => setTarget(null),
  });

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setTarget(null);
    }
  }, []);
  const handleConfirm = useCallback(
    (confirmName: string) => restore.mutate(confirmName),
    [restore]
  );

  const status = serviceLabel(database.status);

  return (
    <AppShell
      actions={<Badge variant="outline">{status.label}</Badge>}
      breadcrumb={
        <DetailBreadcrumb
          environment={database.environment}
          name={database.name}
          project={database.project}
        />
      }
      email={email}
      title={database.name}
    >
      <p className="mb-3 truncate text-muted-foreground text-sm">
        {ENGINE_LABEL[database.engine] ?? database.engine} ·{" "}
        {database.serverName}
      </p>

      <BackupPanel
        canCreate={canCreateBackup}
        canRestore={canRestoreBackup}
        databaseId={database.id}
        databaseName={database.name}
        onRestore={setTarget}
        retention={database.backupRetention}
        schedule={database.backupSchedule}
      />
      {restore.isError ? (
        <Alert className="mt-3" variant="destructive">
          <AlertDescription>
            {restore.error instanceof Error
              ? restore.error.message
              : "restore refused"}
          </AlertDescription>
        </Alert>
      ) : null}
      <RestoreDialog
        backup={target}
        databaseName={database.name}
        onConfirm={handleConfirm}
        onOpenChange={handleClose}
        pending={restore.isPending}
      />
    </AppShell>
  );
}
