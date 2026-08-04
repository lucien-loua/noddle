// Les comptes de l'installation.
//
// Tout passe par le plugin `admin` de better-auth plutôt que par des écritures
// directes en base : lui seul sait hacher un mot de passe, révoquer les
// sessions d'un compte supprimé et refuser qu'on se retire soi-même. Écrire
// dans la table `user` à la main contournerait les trois.
import { user } from "@noddle/db/schema";
import {
  accountIdSchema,
  accountRoleSchema,
  createAccountSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { requirePermission } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface AccountRow {
  createdAt: string;
  email: string;
  id: string;
  /** Vrai pour le compte de la session courante : l'interface doit l'empêcher
   *  de se retirer lui-même, en plus du refus serveur. */
  isSelf: boolean;
  name: string;
  role: string;
}

export const getAccounts = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccountRow[]> => {
    const session = await requireSession();
    const rows = await db.query.user.findMany({ orderBy: user.createdAt });
    return rows.map((u) => ({
      createdAt: u.createdAt.toISOString(),
      email: u.email,
      id: u.id,
      isSelf: u.id === session.user.id,
      name: u.name,
      role: u.role ?? "viewer",
    }));
  }
);

/**
 * Crée un compte, et rend son mot de passe UNE SEULE FOIS.
 *
 * Même règle que le secret d'un webhook : il doit sortir vers un tiers — ici
 * la personne à qui on ouvre l'accès — donc il s'affiche une fois et n'est
 * jamais relu. Contrairement au mot de passe d'une base de données, qui n'a
 * aucun tiers à qui être donné et ne sort donc jamais.
 */
export const createAccount = createServerFn({ method: "POST" })
  .validator(createAccountSchema)
  .handler(async ({ data }): Promise<{ password: string }> => {
    await requirePermission({ action: "create", resource: "user" });

    // Généré par Noddle, jamais choisi : un mot de passe saisi par
    // l'administrateur est un mot de passe qu'il connaît.
    const password = crypto.randomUUID().replaceAll("-", "");

    await auth.api.createUser({
      body: {
        email: data.email,
        name: data.name,
        password,
        role: data.role,
      },
      headers: getRequestHeaders(),
    });

    return { password };
  });

export const setAccountRole = createServerFn({ method: "POST" })
  .validator(accountRoleSchema)
  .handler(async ({ data }): Promise<{ saved: true }> => {
    await requirePermission({ action: "set-role", resource: "user" });

    await assertNotLastOwner(data.userId, data.role);

    await auth.api.setRole({
      body: { role: data.role, userId: data.userId },
      headers: getRequestHeaders(),
    });
    return { saved: true };
  });

export const removeAccount = createServerFn({ method: "POST" })
  .validator(accountIdSchema)
  .handler(async ({ data }): Promise<{ removed: true }> => {
    const session = await requirePermission({
      action: "delete",
      resource: "user",
    });

    if (data.userId === session.user.id) {
      throw new Error("You cannot delete your own account.");
    }
    await assertNotLastOwner(data.userId, "viewer");

    await auth.api.removeUser({
      body: { userId: data.userId },
      headers: getRequestHeaders(),
    });
    return { removed: true };
  });

/**
 * Refuse de retirer le dernier propriétaire.
 *
 * C'est le seul garde-fou qui protège contre une installation VERROUILLÉE :
 * un administrateur qui rétrograde ou supprime le dernier `owner` laisserait
 * une machine où plus personne ne peut créer de compte. Aucune permission ne
 * le dit — c'est une propriété de l'ensemble, pas d'une action.
 */
async function assertNotLastOwner(
  targetId: string,
  nextRole: string
): Promise<void> {
  const target = await db.query.user.findFirst({
    where: eq(user.id, targetId),
  });
  if (target?.role !== "owner" || nextRole === "owner") {
    return;
  }
  const owners = await db.query.user.findMany({
    where: eq(user.role, "owner"),
  });
  if (owners.length <= 1) {
    throw new Error(
      "This account is the last owner — removing it would leave the installation with nobody able to grant access."
    );
  }
}
