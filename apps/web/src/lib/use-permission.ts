// Le masquage côté client.
//
// **Ce n'est PAS la sécurité.** `requirePermission` côté serveur est la
// permission ; ceci n'est qu'une politesse — ne pas proposer un bouton dont
// on sait qu'il sera refusé. Les deux évaluent la MÊME table de rôles,
// importée du même fichier, donc l'interface ne peut pas diverger du serveur.
//
// `checkRolePermission` est SYNCHRONE : pas d'aller-retour, donc pas de
// bouton qui apparaît puis disparaît une fois la réponse arrivée.
import { authClient } from "@/lib/auth-client";
import type { roles, statement } from "@/lib/permissions";

type Statement = typeof statement;
type RoleName = keyof typeof roles;

export function useCan<R extends keyof Statement>(
  role: RoleName | null | undefined,
  resource: R,
  action: Statement[R][number]
): boolean {
  if (!role) {
    return false;
  }
  return authClient.admin.checkRolePermission({
    permissions: { [resource]: [action] },
    role,
  });
}
