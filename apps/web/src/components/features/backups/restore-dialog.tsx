import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { relativeTime } from "@/lib/format";
import type { RestoreTarget } from "./types";

/**
 * The restore confirmation.
 *
 * It asks for the name to be typed in by hand, and that's not an
 * ornament: the server refuses the request if the name doesn't match.
 */
export function RestoreDialog({
  databaseName,
  onConfirm,
  onOpenChange,
  pending,
  target,
}: {
  databaseName: string;
  onConfirm: (confirmName: string) => void;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  target: RestoreTarget | null;
}) {
  const description =
    target?.kind === "run" ? (
      <>
        The live data in this database will be{" "}
        <strong>permanently replaced</strong> by the dump taken{" "}
        {relativeTime(target.backup.createdAt)}. Noddle writes a safety dump
        first, so you can undo the restore if needed.
      </>
    ) : (
      <>
        The live data in this database will be{" "}
        <strong>permanently replaced</strong> by
        {target ? (
          <>
            {" "}
            <code className="text-xs">{target.objectKey}</code>
          </>
        ) : (
          " the selected dump"
        )}
        . Noddle writes a safety dump first.
      </>
    );

  return (
    <ConfirmNameDialog
      confirmLabel="Restore database"
      description={description}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={target !== null}
      pending={pending}
      resourceName={databaseName}
      title={`Restore ${databaseName}?`}
    />
  );
}
