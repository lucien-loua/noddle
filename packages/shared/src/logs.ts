// Contrat du flux de logs entre le worker et le web.
//
// Les deux sont des PROCESSUS SÉPARÉS : le worker écrit les logs de build sur
// le disque du plan de contrôle et appelle un callback local, qui ne traverse
// évidemment pas la frontière de processus. Le web passe donc par Redis, déjà
// présent pour BullMQ.
//
// Deux canaux, deux rôles :
//
//   PUBLISH  noddle-logs:<id>      le direct. Fire-and-forget : un abonné qui
//                                  arrive en retard n'a rien manqué à ses yeux.
//   RPUSH    noddle-logbuf:<id>    le rattrapage, plafonné. C'est lui qui rend
//                                  utilisable un onglet ouvert au milieu d'un
//                                  build, et une reconnexion après coupure.
//
// Ce qui n'est PAS ici : l'archive. Un déploiement terminé se relit depuis le
// fichier pointé par `deployment_logs.storage_url`. Redis ne garde que la
// fenêtre chaude, sinon on rebâtit un stockage de logs dans une base mémoire.
//
// Fichier volontairement pur — aucun import de runtime — pour être chargé
// aussi bien par le worker (Node) que par le web (Bun).

/**
 * Le « : » est permis ici. L'interdiction connue ne vise QUE les noms de file
 * BullMQ, qui s'en sert comme séparateur de clés Redis et refuse de démarrer.
 * Ce sont des clés Redis ordinaires, pas des files.
 */
export function logChannel(deploymentId: string): string {
  return `noddle-logs:${deploymentId}`;
}

export function logBufferKey(deploymentId: string): string {
  return `noddle-logbuf:${deploymentId}`;
}

/**
 * Le tampon de rattrapage est plafonné en NOMBRE D'ENTRÉES, pas en octets.
 * Un build Next.js produit des dizaines de milliers de lignes ; garder la
 * dernière fenêtre suffit à comprendre où il en est, et l'intégralité reste
 * dans le fichier.
 */
export const LOG_BUFFER_MAX_ENTRIES = 2000;

/**
 * Le tampon meurt de lui-même. Sans TTL, chaque déploiement laisserait sa
 * fenêtre en mémoire indéfiniment — sur une VM à 2 Go, Redis finirait par
 * disputer sa RAM aux applications déployées.
 */
export const LOG_BUFFER_TTL_SECONDS = 3600;

export type LogMessage =
  | { type: "chunk"; data: string }
  /**
   * Le déploiement a atteint un statut terminal. Sans ce message, un flux SSE
   * resterait ouvert indéfiniment après la fin du build : le client n'a aucun
   * autre moyen de distinguer « terminé » de « silencieux ».
   */
  | { type: "end"; status: string };

export function encodeLogMessage(message: LogMessage): string {
  return JSON.stringify(message);
}

/**
 * Renvoie `null` plutôt que de lever : un message illisible sur le canal ne
 * doit pas faire tomber le flux d'un spectateur.
 */
export function decodeLogMessage(raw: string): LogMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const candidate = parsed as Partial<LogMessage>;
    if (candidate.type === "chunk" && typeof candidate.data === "string") {
      return { data: candidate.data, type: "chunk" };
    }
    if (candidate.type === "end" && typeof candidate.status === "string") {
      return { status: candidate.status, type: "end" };
    }
    return null;
  } catch {
    return null;
  }
}

/** Statuts après lesquels plus aucune ligne n'arrivera. */
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "rolled_back",
  "reverted_by_watch",
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
