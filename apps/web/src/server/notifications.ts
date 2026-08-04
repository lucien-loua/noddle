// Canaux de notification : lister, ajouter, modifier, éprouver, supprimer.
//
// « Éprouver » envoie une VRAIE notification, comme « Tester » envoie un vrai
// objet dans le compartiment S3. La raison est la même : un canal qu'on croit
// branché et qui ne l'est pas est pire que pas de canal du tout, parce qu'il
// fait croire à une surveillance qui n'existe pas. Un test qui vérifierait
// seulement la forme de l'URL réussirait sur un webhook révoqué.

import { notificationChannels } from "@noddle/db/schema";
import { deliver } from "@noddle/notifier";
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/shared/crypto";
import {
  notificationChannelIdSchema,
  notificationChannelSchema,
  notificationChannelUpdateSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { requirePermission } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

/**
 * Le canal tel qu'il revient au navigateur : SANS son URL.
 *
 * Elle ne ressort jamais, même chiffrée — une URL de webhook Discord ou Slack
 * est un secret porteur, qui la détient peut écrire dans le salon. Même règle
 * que la clé secrète S3 et le mot de passe d'une base.
 */
export interface ChannelRow {
  enabled: boolean;
  id: string;
  kind: "discord" | "slack" | "webhook";
  lastError: string | null;
  lastSuccessAt: string | null;
  name: string;
  notifySuccess: boolean;
}

function toRow(c: typeof notificationChannels.$inferSelect): ChannelRow {
  return {
    enabled: c.enabled,
    id: c.id,
    kind: c.kind,
    lastError: c.lastError,
    lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
    name: c.name,
    notifySuccess: c.notifySuccess,
  };
}

export const getChannels = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChannelRow[]> => {
    await requireSession();
    const rows = await db.query.notificationChannels.findMany({
      orderBy: notificationChannels.createdAt,
    });
    return rows.map(toRow);
  }
);

export const addChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    await requirePermission({ action: "manage", resource: "notification" });

    // Le chiffrement est lié à l'id de la ligne (AAD) : insertion puis mise à
    // jour, comme pour une clé SSH de serveur ou une destination S3.
    const [created] = await db
      .insert(notificationChannels)
      .values({
        kind: data.kind,
        name: data.name,
        notifySuccess: data.notifySuccess,
        urlEncrypted: "placeholder",
      })
      .returning();
    if (!created) {
      throw new Error("could not create channel");
    }
    await db
      .update(notificationChannels)
      .set({
        urlEncrypted: encryptSecret(
          data.url,
          env.appKey,
          secretContext.notificationChannel(created.id)
        ),
      })
      .where(eq(notificationChannels.id, created.id));
    return { id: created.id };
  });

export const updateChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelUpdateSchema)
  .handler(async ({ data }): Promise<{ saved: true }> => {
    await requirePermission({ action: "manage", resource: "notification" });

    const existing = await db.query.notificationChannels.findFirst({
      where: eq(notificationChannels.id, data.channelId),
    });
    if (!existing) {
      throw new Error("channel not found");
    }

    // URL absente = « garde celle d'avant » : le formulaire ne peut pas la
    // réafficher pour la renvoyer, puisqu'elle n'en sort jamais.
    const urlEncrypted = data.url
      ? encryptSecret(
          data.url,
          env.appKey,
          secretContext.notificationChannel(existing.id)
        )
      : existing.urlEncrypted;

    await db
      .update(notificationChannels)
      .set({
        enabled: data.enabled,
        name: data.name,
        notifySuccess: data.notifySuccess,
        updatedAt: new Date(),
        urlEncrypted,
      })
      .where(eq(notificationChannels.id, existing.id));
    return { saved: true };
  });

export const deleteChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelIdSchema)
  .handler(async ({ data }): Promise<{ deleted: true }> => {
    await requirePermission({ action: "manage", resource: "notification" });
    await db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, data.channelId));
    return { deleted: true };
  });

/**
 * Envoie une vraie notification de test, et enregistre le résultat.
 *
 * Le résultat est écrit sur le canal, pas seulement renvoyé : c'est la même
 * colonne que le worker alimente, donc un test réussi remet le voyant au vert
 * exactement comme le ferait un vrai événement. Deux chemins qui écriraient
 * deux états différents finiraient par se contredire à l'écran.
 */
export const testChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelIdSchema)
  .handler(async ({ data }): Promise<{ error?: string; ok: boolean }> => {
    await requirePermission({ action: "manage", resource: "notification" });

    const channel = await db.query.notificationChannels.findFirst({
      where: eq(notificationChannels.id, data.channelId),
    });
    if (!channel) {
      throw new Error("channel not found");
    }

    const url = decryptSecret(
      channel.urlEncrypted,
      env.appKey,
      secretContext.notificationChannel(channel.id)
    );
    const result = await deliver(
      { kind: channel.kind, url },
      {
        detail: "If you are reading this, the channel works.",
        resource: "test",
        type: "deploy_succeeded",
      }
    );

    await db
      .update(notificationChannels)
      .set(
        result.ok
          ? { lastError: null, lastSuccessAt: new Date() }
          : { lastError: result.error ?? "unknown failure" }
      )
      .where(eq(notificationChannels.id, channel.id));

    return { error: result.error, ok: result.ok };
  });
