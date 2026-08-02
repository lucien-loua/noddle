// Variables d'environnement : lecture masquée, écriture par lot.
//
// Règle qui façonne toute cette API : une server function ne renvoie JAMAIS un
// secret déchiffré. Ce n'est pas un contrôle d'affichage — la réponse part sur
// le réseau et se retrouve dans le cache du navigateur, dans les outils de
// développement et dans les journaux d'un proxy.
//
// Conséquence directe : le formulaire ne peut pas envoyer « voici l'état
// complet souhaité », puisqu'il ignore la valeur des secrets. Il envoie donc
// `value: null` pour dire « celle-ci, n'y touche pas ».
import { envVars } from "@noddle/db/schema";
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/shared/crypto";
import { envVarKeySchema } from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { requireSession } from "@/lib/session.server";

export interface EnvVarView {
  id: string;
  isSecret: boolean;
  key: string;
  /** `null` pour un secret — jamais déchiffré vers le client. */
  value: string | null;
}

export const getEnvVars = createServerFn({ method: "GET" })
  .validator((data: { serviceId: string }) => data)
  .handler(async ({ data }): Promise<EnvVarView[]> => {
    await requireSession();

    const rows = await db.query.envVars.findMany({
      orderBy: envVars.key,
      where: eq(envVars.serviceId, data.serviceId),
    });

    return rows.map((row) => ({
      id: row.id,
      isSecret: row.isSecret,
      key: row.key,
      // Les valeurs non secrètes sont chiffrées au repos elles aussi — un seul
      // chemin de code, donc aucun oubli possible — mais rien n'interdit de
      // les rendre à un administrateur authentifié. C'est `isSecret` qui
      // tranche, pas le mode de stockage.
      value: row.isSecret
        ? null
        : decryptSecret(
            row.valueEncrypted,
            env.appKey,
            secretContext.envVar(row.id)
          ),
    }));
  });

const envVarWriteSchema = z.object({
  isSecret: z.boolean(),
  key: envVarKeySchema,
  /** `null` = conserver la valeur déjà enregistrée. */
  value: z.string().max(65_536).nullable(),
});

const saveEnvVarsSchema = z.object({
  serviceId: z.uuid(),
  vars: z.array(envVarWriteSchema).max(500),
});

export interface EnvVarSaveResult {
  added: string[];
  removed: string[];
  updated: string[];
}

export const saveEnvVars = createServerFn({ method: "POST" })
  .validator(saveEnvVarsSchema)
  .handler(async ({ data }): Promise<EnvVarSaveResult> => {
    await requireSession();

    const seen = new Set<string>();
    for (const v of data.vars) {
      if (seen.has(v.key)) {
        throw new Error(`clé en double : ${v.key}`);
      }
      seen.add(v.key);
    }

    const result: EnvVarSaveResult = { added: [], removed: [], updated: [] };

    // Tout ou rien. L'utilisateur a validé UN diff : si la douzième variable
    // échoue, appliquer les onze premières laisserait le service dans un état
    // que personne n'a demandé — et qui partirait tel quel au prochain
    // déploiement.
    await db.transaction(async (tx) => {
      const existing = await tx.query.envVars.findMany({
        where: eq(envVars.serviceId, data.serviceId),
      });
      const byKey = new Map(existing.map((row) => [row.key, row]));

      for (const incoming of data.vars) {
        const current = byKey.get(incoming.key);

        if (current) {
          // `value === null` veut dire « ne touche pas à celle-ci » — le cas
          // d'un secret que le formulaire ne pouvait ni afficher ni renvoyer.
          const nextValue = incoming.value;
          const flagChanged = current.isSecret !== incoming.isSecret;
          if (nextValue === null && !flagChanged) {
            continue;
          }

          // biome-ignore lint/performance/noAwaitInLoops: écritures ordonnées dans une transaction
          await tx
            .update(envVars)
            .set({
              isSecret: incoming.isSecret,
              updatedAt: new Date(),
              ...(nextValue === null
                ? {}
                : {
                    valueEncrypted: encryptSecret(
                      nextValue,
                      env.appKey,
                      secretContext.envVar(current.id)
                    ),
                  }),
            })
            .where(eq(envVars.id, current.id));
          result.updated.push(incoming.key);
          continue;
        }

        if (incoming.value === null) {
          throw new Error(
            `${incoming.key} est une nouvelle variable : elle a besoin d'une valeur`
          );
        }
        // L'AAD lie le chiffré à la LIGNE. L'identifiant doit donc exister
        // avant le chiffrement, d'où un uuid généré ici plutôt que par défaut
        // en base.
        const id = crypto.randomUUID();
        await tx.insert(envVars).values({
          id,
          isSecret: incoming.isSecret,
          key: incoming.key,
          serviceId: data.serviceId,
          valueEncrypted: encryptSecret(
            incoming.value,
            env.appKey,
            secretContext.envVar(id)
          ),
        });
        result.added.push(incoming.key);
      }

      const removed = existing.filter((row) => !seen.has(row.key));
      if (removed.length > 0) {
        await tx.delete(envVars).where(
          and(
            eq(envVars.serviceId, data.serviceId),
            inArray(
              envVars.id,
              removed.map((row) => row.id)
            )
          )
        );
        result.removed = removed.map((row) => row.key);
      }
    });

    return result;
  });
