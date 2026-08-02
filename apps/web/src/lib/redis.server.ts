// Le côté web du pont de logs : abonnement Redis + refanout en mémoire.
//
// Une connexion ioredis en mode ABONNÉ ne peut plus exécuter aucune autre
// commande — c'est une contrainte du protocole Redis, pas de la bibliothèque.
// D'où exactement deux connexions, et une seule quel que soit le nombre
// d'onglets ouverts :
//
//   `redis`    commandes ordinaires (rattrapage LRANGE, dépôt BullMQ)
//   `hub`      une connexion abonnée, refanoutée en mémoire vers N flux SSE
//
// Un abonnement Redis par spectateur marcherait aussi, et ouvrirait une
// connexion par onglet sur une machine à 2 Go.
import {
  decodeLogMessage,
  type LogMessage,
  logBufferKey,
  logChannel,
} from "@noddle/shared/logs";
import IORedis from "ioredis";
import { env } from "@/lib/env.server";

export type LogListener = (message: LogMessage) => void;

// Le rechargement à chaud de Vite réévalue ce module à chaque édition. Sans
// mémoïsation sur globalThis, chaque sauvegarde laisserait deux connexions
// Redis orphelines derrière elle.
const globalForRedis = globalThis as typeof globalThis & {
  __noddleRedis?: IORedis;
  __noddleLogHub?: LogHub;
};

export const redis: IORedis =
  globalForRedis.__noddleRedis ??
  new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
globalForRedis.__noddleRedis = redis;

class LogHub {
  private readonly subscriber: IORedis;
  private readonly listeners = new Map<string, Set<LogListener>>();

  constructor(connection: IORedis) {
    this.subscriber = connection.duplicate();
    this.subscriber.on("message", (channel, raw) => {
      const message = decodeLogMessage(raw);
      if (!message) {
        // Un message illisible ne doit pas faire tomber les spectateurs.
        return;
      }
      for (const listener of this.listeners.get(channel) ?? []) {
        listener(message);
      }
    });
  }

  /** Renvoie de quoi se désabonner. À appeler à la fermeture du flux SSE. */
  async subscribe(
    deploymentId: string,
    listener: LogListener
  ): Promise<() => void> {
    const channel = logChannel(deploymentId);
    let set = this.listeners.get(channel);

    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(channel);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.subscriber.unsubscribe(channel).catch(() => {
          // le canal disparaîtra avec la connexion
        });
      }
    };
  }

  /**
   * Ce qui a déjà défilé avant l'arrivée de ce spectateur.
   *
   * Sans ça, ouvrir le dashboard au milieu d'un build de trois minutes montre
   * un écran vide jusqu'à la ligne suivante — et le pub/sub Redis, qui est du
   * fire-and-forget, ne rejouera jamais ce qui est passé.
   */
  async backlog(deploymentId: string): Promise<LogMessage[]> {
    const raw = await redis.lrange(logBufferKey(deploymentId), 0, -1);
    const messages: LogMessage[] = [];
    for (const entry of raw) {
      const message = decodeLogMessage(entry);
      if (message) {
        messages.push(message);
      }
    }
    return messages;
  }
}

export const logHub: LogHub =
  globalForRedis.__noddleLogHub ?? new LogHub(redis);
globalForRedis.__noddleLogHub = logHub;
