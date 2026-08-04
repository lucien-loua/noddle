// Envoi des notifications. Un POST JSON, trois formes de charge utile.
//
// Aucune dépendance : `fetch` existe sur les deux runtimes. Un client Discord
// ou Slack ne ferait qu'emballer un POST tout en ajoutant une bibliothèque à
// suivre — et la dérive des dépendances tierces est le risque numéro un
// mesuré de ce projet.
//
// Deux règles portent tout ce fichier :
//
//   · un envoi qui échoue en SILENCE est pire que pas de notification du
//     tout — on se croit surveillé. D'où un résultat rendu, jamais une
//     exception avalée, et des colonnes `last_error`/`last_success_at` que
//     l'appelant écrit ;
//   · un envoi ne doit JAMAIS faire échouer ce qui l'a déclenché. Un Discord
//     injoignable ne transforme pas un déploiement réussi en déploiement
//     échoué. Même règle que la purge de rétention des sauvegardes.

/** Au-delà, on renonce. Un destinataire lent ne doit pas retenir un job. */
const TIMEOUT_MS = 10_000;

const COLOR_FAILURE = 0xd1_3d_3d;
const COLOR_SUCCESS = 0x2e_9e_4f;

export type NotificationKind = "discord" | "slack" | "webhook";

export type NotificationEventType =
  | "backup_failed"
  | "deploy_failed"
  | "deploy_reverted"
  | "deploy_succeeded"
  | "watch_reverted";

export interface NotificationEvent {
  /** Message d'erreur ou précision. Jamais un secret : ceci part chez un tiers. */
  detail?: string;
  /** Le nom du service, de la pile ou de la base concernée. */
  resource: string;
  type: NotificationEventType;
  /** Lien vers le dashboard, quand l'installation connaît son domaine. */
  url?: string;
}

export interface NotificationTarget {
  kind: NotificationKind;
  /** En clair. Déchiffrée au plus près de l'usage, jamais journalisée. */
  url: string;
}

export interface DeliveryResult {
  error?: string;
  ok: boolean;
  /** Le code HTTP, quand la requête a abouti. Absent sur une panne réseau. */
  status?: number;
}

/**
 * Les libellés, en un seul endroit.
 *
 * `deploy_reverted` et `watch_reverted` sont distingués volontairement, comme
 * ils le sont déjà en base : le premier veut dire « Swarm a refusé la bascule,
 * l'ancienne version n'a jamais cessé de servir », le second « le déploiement
 * avait réussi, puis l'application s'est mise à boucler et Noddle est
 * intervenu ». Les confondre effacerait la seule différence qui compte pour la
 * confiance qu'on accorde à l'outil.
 */
const LABELS: Record<NotificationEventType, string> = {
  backup_failed: "Sauvegarde échouée",
  deploy_failed: "Déploiement échoué",
  deploy_reverted: "Déploiement annulé par Swarm",
  deploy_succeeded: "Déployé",
  watch_reverted: "Repris par la surveillance",
};

export function isFailure(type: NotificationEventType): boolean {
  return type !== "deploy_succeeded";
}

export function eventLabel(type: NotificationEventType): string {
  return LABELS[type];
}

/** Une ligne de texte lisible telle quelle, quel que soit le destinataire. */
function summarize(event: NotificationEvent): string {
  const head = `${LABELS[event.type]} — ${event.resource}`;
  return event.detail ? `${head}\n${event.detail}` : head;
}

/**
 * La charge utile, par destinataire.
 *
 * Discord reçoit un embed parce que sa couleur porte la gravité : sur un
 * salon qui défile, elle se lit sans lire. Slack reçoit du texte simple —
 * ses `blocks` sont plus riches mais rejettent tout le message si un champ
 * est malformé, et un canal d'alerte doit être robuste avant d'être joli.
 * `webhook` reçoit la forme brute de Noddle, celle qui se branche sur autre
 * chose : structurée, pas mise en forme.
 */
export function buildPayload(
  kind: NotificationKind,
  event: NotificationEvent
): unknown {
  const failure = isFailure(event.type);

  if (kind === "discord") {
    return {
      embeds: [
        {
          color: failure ? COLOR_FAILURE : COLOR_SUCCESS,
          description: event.detail ?? undefined,
          fields: event.url
            ? [{ inline: false, name: "Dashboard", value: event.url }]
            : undefined,
          title: `${LABELS[event.type]} — ${event.resource}`,
        },
      ],
      username: "Noddle",
    };
  }

  if (kind === "slack") {
    const suffix = event.url ? `\n<${event.url}|Ouvrir le dashboard>` : "";
    return {
      text: `${failure ? ":rotating_light:" : ":white_check_mark:"} ${summarize(event)}${suffix}`,
    };
  }

  return {
    at: new Date().toISOString(),
    detail: event.detail ?? null,
    failure,
    resource: event.resource,
    type: event.type,
    url: event.url ?? null,
  };
}

/**
 * Envoie, et RAPPORTE — ne lève jamais.
 *
 * Le code HTTP est lu, pas supposé : un webhook Discord révoqué répond 404 et
 * un salon supprimé 401, sans que la requête échoue au sens réseau. Conclure
 * du seul fait que `fetch` a abouti reproduirait exactement l'erreur que le
 * projet refuse ailleurs — inférer un succès d'un code de sortie.
 */
export async function deliver(
  target: NotificationTarget,
  event: NotificationEvent
): Promise<DeliveryResult> {
  const body = JSON.stringify(buildPayload(target.kind, event));

  try {
    const response = await fetch(target.url, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }
    // Le corps est lu mais TRONQUÉ : certaines passerelles renvoient une page
    // d'erreur entière, et on n'écrit pas dix kilo-octets de HTML dans une
    // colonne que l'interface affiche.
    const text = await response.text().catch(() => "");
    return {
      error: `HTTP ${response.status} ${text.slice(0, 300)}`.trim(),
      ok: false,
      status: response.status,
    };
  } catch (err) {
    // L'URL n'apparaît PAS dans le message : elle est porteuse — qui la
    // détient peut écrire dans le salon — et ce message finit dans une colonne
    // affichée à l'écran.
    return { error: describeFailure(err), ok: false };
  }
}

/**
 * Une cause lisible, SANS l'URL et SANS le message du runtime.
 *
 * Deux raisons de ne pas rendre `err.message` tel quel :
 *
 *   · il est porteur du runtime. Node dit « fetch failed », Bun dit « Unable
 *     to connect. Is the computer able to access the url? ». Or les deux
 *     envoient : le web (Bun) éprouve les canaux, le worker (Node) émet les
 *     événements. Le MÊME canal en panne s'afficherait donc différemment
 *     selon qui a essayé — constaté à l'écran ;
 *   · il est en anglais dans une interface française.
 *
 * On ne garde donc que la distinction qui change quelque chose pour qui lit :
 * le destinataire a-t-il répondu trop tard, ou pas du tout.
 */
function describeFailure(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `pas de réponse en ${TIMEOUT_MS / 1000} s`;
  }
  return "destinataire injoignable";
}
