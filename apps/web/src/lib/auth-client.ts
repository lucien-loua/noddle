// Client better-auth, côté navigateur.
//
// Pas de `baseURL` : le dashboard est servi par la même origine que
// l'API d'authentification, et un utilisateur auto-hébergé atteint sa machine
// à une adresse que personne ne connaît à la compilation.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
