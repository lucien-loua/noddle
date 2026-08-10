import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface WebhookStatus {
  configured: boolean;
  path: string;
}

interface Revealed {
  path: string;
  secret: string;
}

interface Props {
  /** `service:create` — the server requires the same permission as a
   *  connected repository, a webhook secret being just as much a way to
   *  trigger a deploy. */
  canManage: boolean;
  generateWebhook: () => Promise<Revealed>;
  getWebhook: () => Promise<WebhookStatus>;
  queryKey: readonly unknown[];
}

// SSR has no origin to offer; the client fills it in after hydration.
const origin = typeof window === "undefined" ? "" : window.location.origin;

export function WebhookPanel({
  canManage,
  generateWebhook,
  getWebhook,
  queryKey,
}: Props) {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const status = useQuery({ queryFn: getWebhook, queryKey });

  const generate = useMutation({
    mutationFn: generateWebhook,
    onSuccess: async (result) => {
      setRevealed(result);
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const handleGenerate = useCallback(() => generate.mutate(), [generate]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-medium text-sm">Webhook</h2>
        {canManage ? (
          <Button
            disabled={generate.isPending}
            onClick={handleGenerate}
            size="sm"
            variant="outline"
          >
            {generate.isPending ? <Spinner data-icon="inline-start" /> : null}
            {status.data?.configured ? "Regenerate" : "Generate"}
          </Button>
        ) : null}
      </div>

      {revealed ? (
        <Alert>
          <AlertDescription className="flex flex-col gap-1">
            <span className="font-medium">
              Copy the secret now — it will never be shown again.
            </span>
            <span className="break-all font-mono text-xs">
              URL: {origin}
              {revealed.path}
            </span>
            <span className="break-all font-mono text-xs">
              Secret: {revealed.secret}
            </span>
          </AlertDescription>
        </Alert>
      ) : (
        <WebhookStatusLine status={status.data} />
      )}
    </div>
  );
}

function WebhookStatusLine({ status }: { status: WebhookStatus | undefined }) {
  if (status?.configured) {
    return (
      <p className="break-all text-muted-foreground text-xs">
        Configured: {origin}
        {status.path}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-xs">
      No webhook yet. Generate one to trigger a deploy on every GitHub or GitLab
      push.
    </p>
  );
}
