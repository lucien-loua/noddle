import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { ApiTokenCreateDialog } from "@/components/features/settings/api-token-create-dialog";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { toast } from "@/components/ui/toast";
import { errorMessage, relativeTime } from "@/lib/format";
import { queries } from "@/lib/queries";
import { getApiTokens, revokeApiToken } from "@/server/api-tokens";
import type { ApiTokenRow } from "@/server/api-tokens";

function scopeSummary(row: ApiTokenRow): string {
  const count = row.effectiveScopes.length;
  const withheld = row.grantedScopes.length - count;
  const base = count === 1 ? "1 permission" : `${count} permissions`;
  return withheld > 0 ? `${base} · ${withheld} withheld by your role` : base;
}

function TokenRow({
  onRevoke,
  row,
}: {
  onRevoke: (row: ApiTokenRow) => void;
  row: ApiTokenRow;
}) {
  const revoke = useCallback(() => onRevoke(row), [onRevoke, row]);
  const expired =
    row.expiresAt !== null && Date.parse(row.expiresAt) < Date.now();

  return (
    <FramePanel className="flex flex-row items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-sm">{row.name}</p>
        <p className="truncate font-mono text-muted-foreground text-xs">
          {row.start ?? "noddle_pat_"}…
        </p>
        <p className="text-muted-foreground text-xs">
          {scopeSummary(row)} ·{" "}
          {row.lastRequest
            ? `used ${relativeTime(row.lastRequest)}`
            : "never used"}{" "}
          ·{" "}
          {row.expiresAt
            ? `${expired ? "expired" : "expires"} ${relativeTime(row.expiresAt)}`
            : "never expires"}
        </p>
      </div>
      <Button onClick={revoke} size="sm" variant="outline">
        Revoke
      </Button>
    </FramePanel>
  );
}

export function ApiTokensPanel() {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [chosen, setChosen] = useState<ApiTokenRow | null>(null);

  const tokens = useQuery<ApiTokenRow[]>({
    queryFn: () => getApiTokens(),
    queryKey: queries.apiTokens().queryKey,
  });

  const revoke = useMutation({
    mutationFn: (row: ApiTokenRow) =>
      revokeApiToken({ data: { id: row.id, typedName: row.name } }),
    onError: (error: Error) =>
      toast.add({
        description: errorMessage(error, "could not revoke"),
        title: "Token not revoked",
        type: "error",
      }),
    onSuccess: () => {
      setChosen(null);
      client.invalidateQueries({ queryKey: queries.apiTokens().queryKey });
      toast.add({ title: "Token revoked", type: "success" });
    },
  });

  const openCreate = useCallback(() => setCreating(true), []);
  const closeConfirm = useCallback(() => setChosen(null), []);
  const confirm = useCallback(() => {
    if (chosen) {
      revoke.mutate(chosen);
    }
  }, [chosen, revoke]);

  const rows = tokens.data ?? [];

  return (
    <Frame stacked variant="ghost">
      <FrameHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-(--frame-panel-header-gap)">
          <FrameTitle>API tokens</FrameTitle>
          <FrameDescription>
            For a script, a pipeline or an agent. A token can never do more than
            your own role allows, whatever it was granted.
          </FrameDescription>
        </div>
        <Button onClick={openCreate} size="sm" variant="outline">
          New token
        </Button>
      </FrameHeader>

      {rows.length === 0 ? (
        <FramePanel>
          <p className="text-muted-foreground text-sm">
            No tokens yet. One is how anything that is not a browser reaches
            this Noddle.
          </p>
        </FramePanel>
      ) : null}

      {rows.map((row) => (
        <TokenRow key={row.id} onRevoke={setChosen} row={row} />
      ))}

      <ApiTokenCreateDialog onOpenChange={setCreating} open={creating} />

      <ConfirmActionDialog
        confirmLabel="Revoke"
        description={`Anything using "${chosen?.name ?? ""}" stops working immediately. Revoking cannot be undone, and the token cannot be shown again — issue a new one instead.`}
        onConfirm={confirm}
        onOpenChange={closeConfirm}
        open={chosen !== null}
        pending={revoke.isPending}
        title="Revoke this token"
      />
    </Frame>
  );
}
