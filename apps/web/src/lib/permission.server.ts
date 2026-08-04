// Le garde de permission. UN point de passage, et une seule façon d'échouer.
//
// Ce fichier existe à côté de `session.server.ts` plutôt que dedans, parce
// qu'il porte la couche RBAC — le palier payant de l'open-core — et que la
// règle posée est « build them so they can be separated ».
//
// **Le problème de ce chantier : un contrôle absent est INVISIBLE.** Une
// server function qu'on ajoute sans garde ne lève rien, ne casse rien, et
// laisse un trou que personne ne remarque avant qu'il serve. On ne peut pas
// voir ce qui manque — donc le mécanisme doit rendre l'omission détectable
// autrement : chaque fonction mutante déclare sa permission ICI, dans une
// table que `verify-permissions.ts` confronte à la liste réelle des server
// functions. Ajouter une fonction sans l'y inscrire fait échouer la
// vérification.
import { auth, type Session } from "@/lib/auth.server";
import type { statement } from "@/lib/permissions";
import { requireSession } from "@/lib/session.server";

type Statement = typeof statement;
type Resource = keyof Statement;

/** Une permission : une ressource et l'une de SES actions, pas n'importe
 *  laquelle — le type empêche `server: ["deploy"]`, qui n'existe pas. */
export type Permission = {
  [R in Resource]: { action: Statement[R][number]; resource: R };
}[Resource];

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Exige une permission. Lève si elle manque.
 *
 * La décision est déléguée au plugin plutôt que recalculée ici : le client
 * masque les actions avec `checkRolePermission`, et si les deux côtés
 * n'évaluaient pas la MÊME table, l'interface finirait par proposer ce que le
 * serveur refuse — ou par cacher ce qu'il autorise, ce qui est pire parce que
 * personne ne le signale.
 *
 * Masquer un bouton n'est de toute façon pas une permission : c'est CE
 * contrôle qui l'est, le masquage n'étant qu'une politesse.
 */
export async function requirePermission(
  permission: Permission
): Promise<Session> {
  const session = await requireSession();

  const result = await auth.api.userHasPermission({
    body: {
      permissions: {
        [permission.resource]: [permission.action],
      } as Record<string, string[]>,
      userId: session.user.id,
    },
  });

  if (!result.success) {
    throw new ForbiddenError(
      `Action refusée : votre rôle ne permet pas « ${permission.action} » sur ${permission.resource}.`
    );
  }
  return session;
}
