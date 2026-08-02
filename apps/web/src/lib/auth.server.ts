// better-auth — un seul compte administrateur en Phase 1.
//
// Noddle est un outil auto-hébergé qu'on installe pour soi : il n'y a pas de
// page d'inscription publique à protéger, il y a UN compte à créer au premier
// démarrage puis plus jamais. Les équipes et le RBAC sont de la Phase 3.
// biome-ignore lint/performance/noNamespaceImport: drizzleAdapter veut l'objet schéma
import * as schema from "@noddle/db/schema";
import { deriveSubkey } from "@noddle/shared/crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { count } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

async function userCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(schema.user);
  return row?.value ?? 0;
}

/** Vrai tant qu'aucun administrateur n'existe : le premier écran est alors la
 *  création du compte, pas une connexion. */
export async function needsSetup(): Promise<boolean> {
  return (await userCount()) === 0;
}

export const auth = betterAuth({
  // `baseURL` n'est PAS fixé ici, et c'est délibéré : personne ne sait à la
  // compilation à quelle adresse un utilisateur atteindra SA machine. À défaut,
  // better-auth dérive l'origine de la requête entrante, ce qui suffit en
  // développement. En production, l'installateur renseigne BETTER_AUTH_URL —
  // la variable de better-auth lui-même, lue sans une ligne de code de notre
  // part — et l'origine est alors vérifiée au lieu d'être crue sur parole.
  database: drizzleAdapter(db, { provider: "pg", schema }),

  // L'inscription est le mécanisme de création du PREMIER compte, et
  // uniquement de celui-là. Le verrou est ici plutôt que dans l'interface :
  // l'endpoint /api/auth/sign-up/email est joignable directement, cacher le
  // formulaire ne protégerait rien.
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          if ((await userCount()) > 0) {
            throw new APIError("FORBIDDEN", {
              message:
                "Noddle n'accepte qu'un compte administrateur en Phase 1.",
            });
          }
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    // Pas de serveur SMTP à configurer pour se connecter à sa propre machine.
    requireEmailVerification: false,
  },

  // Dérivé d'APP_KEY plutôt qu'ajouté à côté : une seule racine de secret à
  // générer et à sauvegarder dans l'installateur.
  secret: deriveSubkey(env.appKey, "noddle-better-auth").toString("base64"),
});

export type Session = typeof auth.$Infer.Session;
