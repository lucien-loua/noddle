// Émission des notifications depuis le worker.
//
// Le worker, parce que c'est LÀ que les événements se produisent : un
// déploiement qui échoue, une surveillance qui reprend la main, une
// sauvegarde qui casse. Le web ne saurait les annoncer qu'en sondant.
//
// La règle qui tient tout ce fichier : **notifier ne doit jamais faire
// échouer ce qui a déclenché la notification.** Un Discord injoignable ne
// transforme pas un déploiement réussi en déploiement échoué. C'est la même
// règle que la purge de rétention des sauvegardes, et elle est appliquée ici
// une fois pour toutes plutôt que par un try/catch recopié à chaque appel.

import { notificationChannels } from "@noddle/db/schema";
import { deliver, isFailure, type NotificationEvent } from "@noddle/notifier";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { eq } from "drizzle-orm";
import type { DeployContext } from "#deploy";

/**
 * Envoie un événement à tous les canaux concernés.
 *
 * Ne lève pas, ne renvoie rien d'exploitable : l'appelant n'a rien à décider
 * sur cette base. Le résultat de chaque envoi est écrit sur le canal, parce
 * que c'est là qu'il sera lu — un envoi qui échoue en silence est pire que
 * pas de notification du tout, on se croit surveillé.
 */
export async function notify(
  ctx: DeployContext,
  event: NotificationEvent
): Promise<void> {
  try {
    const channels = await ctx.db.query.notificationChannels.findMany({
      where: eq(notificationChannels.enabled, true),
    });

    const concerned = channels.filter(
      (c) => isFailure(event.type) || c.notifySuccess
    );
    if (concerned.length === 0) {
      return;
    }

    // En parallèle : un canal lent ne doit pas retarder les autres, et chacun
    // porte déjà son propre délai d'attente.
    await Promise.all(
      concerned.map(async (channel) => {
        const url = decryptSecret(
          channel.urlEncrypted,
          ctx.appKey,
          secretContext.notificationChannel(channel.id)
        );
        const result = await deliver({ kind: channel.kind, url }, event);

        await ctx.db
          .update(notificationChannels)
          .set(
            result.ok
              ? { lastError: null, lastSuccessAt: new Date() }
              : { lastError: result.error ?? "échec inconnu" }
          )
          .where(eq(notificationChannels.id, channel.id));
      })
    );
  } catch (err) {
    // Y compris une base injoignable ou un déchiffrement impossible. Rien de
    // ce qui se passe ici n'a le droit de remonter jusqu'au job.
    process.stderr.write(
      `notification non envoyée : ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}
