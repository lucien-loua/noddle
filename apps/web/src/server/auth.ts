// Ce que le client a le droit de savoir sur l'état d'authentification.
import { createServerFn } from "@tanstack/react-start";
import { needsSetup } from "@/lib/auth.server";
import { getSession } from "@/lib/session.server";

export interface AuthState {
  email: string | null;
  /** Aucun administrateur n'existe encore : le premier écran est une création. */
  needsSetup: boolean;
  signedIn: boolean;
}

export const getAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthState> => {
    const session = await getSession();
    return {
      email: session?.user.email ?? null,
      // Interrogé même connecté : c'est une seule requête `count`, et ça évite
      // au routeur un second aller-retour au moment où il en a besoin.
      needsSetup: await needsSetup(),
      signedIn: session !== null,
    };
  }
);
