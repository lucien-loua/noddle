// Client better-auth, côté navigateur.
//
// Pas de `baseURL` : le dashboard est servi par la même origine que
// l'API d'authentification, et un utilisateur auto-hébergé atteint sa machine
// à une adresse que personne ne connaît à la compilation.
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "@/lib/permissions";

export const authClient = createAuthClient({
  // Les MÊMES rôles que le serveur, importés du même fichier. Deux
  // définitions divergentes donneraient une interface qui propose une action
  // que le serveur refuse — ou pire, qui en cache une qu'il autorise.
  plugins: [adminClient({ ac, roles })],
});
