// Panneau webhook, partagé entre service et pile : même mécanique, seule la
// paire de fonctions serveur change côté appelant.
//
// Le secret n'est montré qu'UNE fois, juste après sa génération — comme un
// jeton d'API. Passé ce moment, l'écran ne sait plus dire que « configuré »
// ou non : le regénérer est le seul chemin, jamais le relire.
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
  /** `service:create` — le serveur exige la même permission qu'un dépôt
   *  connecté, un secret de webhook étant un moyen de déclencher un
   *  déploiement au même titre. */
  canManage: boolean;
  generateWebhook: () => Promise<Revealed>;
  getWebhook: () => Promise<WebhookStatus>;
  queryKey: readonly unknown[];
}

// SSR n'a pas d'origine à offrir ; le client la complète après hydratation.
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
            {status.data?.configured ? "Régénérer" : "Générer"}
          </Button>
        ) : null}
      </div>

      {revealed ? (
        <Alert>
          <AlertDescription className="flex flex-col gap-1">
            <span className="font-medium">
              Copiez le secret maintenant : il ne sera plus jamais affiché.
            </span>
            <span className="break-all font-mono text-xs">
              URL : {origin}
              {revealed.path}
            </span>
            <span className="break-all font-mono text-xs">
              Secret : {revealed.secret}
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
        Configuré : {origin}
        {status.path}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-xs">
      Aucun webhook. Générez-en un pour déclencher un déploiement à chaque push
      GitHub ou GitLab.
    </p>
  );
}
