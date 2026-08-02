// Surveillance post-déploiement.
//
// Raison d'être, mesurée en Phase 0 sur une VM réelle, même image, seul le
// délai du crash changeant :
//
//   meurt à 25 s (dans la fenêtre monitor)  → Swarm annule, la version
//                                             précédente ressert
//   meurt à 90 s (hors fenêtre)             → update rapporté « completed »,
//                                             l'ancienne task est déjà drainée,
//                                             la restart policy relance
//                                             L'IMAGE CASSÉE indéfiniment.
//                                             Disponibilité mesurée : 9/12
//                                             requêtes sur 60 s.
//
// La garantie de Swarm a donc une date de péremption. Allonger la fenêtre n'est
// pas la réponse : chaque déploiement attendrait d'autant, et un crash une
// minute plus tard passerait quand même. Les vraies applications meurent sous
// charge après plusieurs minutes — le cas « hors fenêtre » est le cas COURANT.
//
// Noddle reprend donc la main là où Swarm s'arrête, et il le peut parce qu'il
// conserve tout l'historique des déploiements : il rejoue n'importe quelle
// image, là où Swarm ne garde qu'une spec antérieure.
import type { DockerApi } from "@noddle/ssh-executor";

export interface WatchVerdict {
  /** Vrai si le service boucle : il a convergé puis s'est mis à redémarrer. */
  crashLooping: boolean;
  /** Nombre de tasks en échec depuis le début de la surveillance. */
  failures: number;
  lastError: string | null;
}

/**
 * Seuil de déclenchement.
 *
 * Deux échecs et non un : une task peut mourir une fois pour une raison
 * extérieure au déploiement (OOM ponctuel, redémarrage du daemon). Revenir en
 * arrière sur un incident isolé serait pire que le laisser passer — on
 * annulerait un déploiement sain.
 */
export const CRASH_LOOP_THRESHOLD = 2;

export async function inspectServiceHealth(
  docker: DockerApi,
  serviceName: string,
  since: Date
): Promise<WatchVerdict> {
  const tasks = await docker.listTasks({
    filters: JSON.stringify({ service: [serviceName] }),
  });

  const sinceMs = since.getTime();
  let failures = 0;
  let lastError: string | null = null;

  for (const t of tasks as unknown as Array<{
    Status?: { State?: string; Timestamp?: string; Err?: string };
  }>) {
    const state = t.Status?.State;
    const ts = t.Status?.Timestamp ? Date.parse(t.Status.Timestamp) : 0;

    // `failed` et `rejected` seulement. `shutdown` est l'état NORMAL d'une task
    // drainée lors d'une mise à jour réussie : la compter ferait voir une
    // boucle de crash dans chaque déploiement.
    if ((state === "failed" || state === "rejected") && ts >= sinceMs) {
      failures += 1;
      lastError = t.Status?.Err ?? lastError;
    }
  }

  return {
    crashLooping: failures >= CRASH_LOOP_THRESHOLD,
    failures,
    lastError,
  };
}

/** Durée pendant laquelle un déploiement reste sous surveillance. */
export const WATCH_WINDOW_MS = 5 * 60 * 1000;

export function watchUntilFor(startedAt: Date): Date {
  return new Date(startedAt.getTime() + WATCH_WINDOW_MS);
}
