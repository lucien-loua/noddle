// Garde de session partagée par toutes les server functions.
//
// Une seule porte d'entrée : chaque fonction serveur qui touche la base
// commence par elle. Noddle pilote des machines et détient des clés SSH — une
// server function non gardée est un accès root distant.
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth, type Session } from "@/lib/auth.server";

export async function getSession(): Promise<Session | null> {
  return await auth.api.getSession({ headers: getRequestHeaders() });
}

/** Lève si personne n'est connecté. À appeler AVANT toute lecture de données. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw new Error("not authenticated");
  }
  return session;
}
