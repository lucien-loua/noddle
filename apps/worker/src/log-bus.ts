// Publication des logs de build vers le web, à travers Redis.
//
// Le worker et le web sont deux processus : le callback `onChunk` du puits de
// logs ne franchit pas cette frontière. Redis est déjà là pour BullMQ, et
// c'est lui qui la franchit.
//
// Pourquoi pas suivre le fichier depuis le web : le direct reposerait alors
// sur inotify à travers un bind mount Docker, entre deux runtimes différents
// (Node écrit, Bun lit). C'est exactement la classe d'interaction tierce qui a
// causé toutes les ruptures des Phases 0 et 1, et le repli — un polling par
// spectateur — coûte de la latence et un descripteur par onglet.
import {
  encodeLogMessage,
  LOG_BUFFER_MAX_ENTRIES,
  LOG_BUFFER_TTL_SECONDS,
  type LogMessage,
  logBufferKey,
  logChannel,
} from "@noddle/shared/logs";
import type IORedis from "ioredis";

export interface LogBus {
  close: () => Promise<void>;
  /** Non bloquant : un déploiement ne doit jamais attendre le dashboard. */
  publish: (deploymentId: string, message: LogMessage) => void;
}

export function createLogBus(connection: IORedis): LogBus {
  // Connexion DÉDIÉE. Un Worker BullMQ occupe la sienne avec des lectures
  // bloquantes ; une publication mise en file derrière l'une d'elles
  // arriverait avec des secondes de retard dans le dashboard.
  const publisher = connection.duplicate();

  return {
    async close() {
      await publisher.quit();
    },

    publish(deploymentId, message) {
      const payload = encodeLogMessage(message);
      const channel = logChannel(deploymentId);
      const bufferKey = logBufferKey(deploymentId);

      // Le direct ET le tampon de rattrapage dans le même aller-retour.
      const pipeline = publisher
        .multi()
        .publish(channel, payload)
        .rpush(bufferKey, payload)
        .ltrim(bufferKey, -LOG_BUFFER_MAX_ENTRIES, -1)
        .expire(bufferKey, LOG_BUFFER_TTL_SECONDS);

      // Un Redis indisponible ne doit pas interrompre un build en cours : le
      // fichier reste la source de vérité, le dashboard n'est qu'un
      // spectateur.
      pipeline.exec().catch(() => {
        // ignoré volontairement
      });
    },
  };
}
