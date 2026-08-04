// better-auth.
//
// Noddle est un outil auto-hébergé : il n'y a pas de page d'inscription
// publique à protéger. Le PREMIER compte se crée au premier démarrage et
// devient `owner` ; les suivants sont créés par un administrateur, jamais par
// inscription. Le verrou vit donc côté serveur — l'endpoint
// /api/auth/sign-up/email est joignable directement, cacher un formulaire ne
// protégerait rien.
// biome-ignore lint/performance/noNamespaceImport: drizzleAdapter veut l'objet schéma
import * as schema from "@noddle/db/schema";
import { deriveSubkey } from "@noddle/shared/crypto";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { admin as adminPlugin } from "better-auth/plugins";
import { count } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { ac, roles } from "@/lib/permissions";

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
        before: async (user) => {
          // ATTENTION — ce hook s'applique à TOUTE création de compte, y
          // compris celle du plugin `admin`. La première version supposait
          // l'inverse et bloquait donc `admin.createUser` : l'installation
          // restait à un compte pour toujours, le verrou empêchant le
          // mécanisme censé le remplacer. Mesuré, 403 sur create-user.
          //
          // On laisse donc passer quand la requête vient d'un compte déjà
          // authentifié : seul un administrateur atteint cet endpoint, le
          // plugin l'ayant lui-même gardé par `adminRoles`.
          const existing = await auth.api
            .getSession({ headers: getRequestHeaders() })
            .catch(() => null);
          if (existing) {
            return;
          }
          if ((await userCount()) > 0) {
            throw new APIError("FORBIDDEN", {
              message:
                "L'inscription est réservée au premier compte. Demandez à un administrateur de vous en créer un.",
            });
          }
          // Le premier compte est `owner`, et c'est ce qui rend une
          // installation utilisable : sans lui, personne ne pourrait créer le
          // deuxième.
          return { data: { ...user, role: "owner" } };
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    // Pas de serveur SMTP à configurer pour se connecter à sa propre machine.
    requireEmailVerification: false,
  },

  plugins: [
    adminPlugin({
      ac,
      // `owner` DOIT y figurer : le plugin garde ses propres endpoints
      // (create-user, set-role, remove-user) derrière cette liste, qui vaut
      // ["admin"] par défaut, et notre rôle d'installation s'appelle `owner`.
      adminRoles: ["owner", "admin"],
      // `viewer` par défaut : un compte fraîchement créé ne doit rien pouvoir
      // casser avant qu'on lui ait donné son rôle. L'inverse — administrateur
      // par défaut, qu'on rétrograde ensuite — laisse une fenêtre pendant
      // laquelle l'oubli coûte cher.
      defaultRole: "viewer",
      roles,
    }),
  ],

  // Dérivé d'APP_KEY plutôt qu'ajouté à côté : une seule racine de secret à
  // générer et à sauvegarder dans l'installateur.
  secret: deriveSubkey(env.appKey, "noddle-better-auth").toString("base64"),
});

export type Session = typeof auth.$Infer.Session;
