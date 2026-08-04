// Qui a le droit de faire quoi.
//
// Bâti sur `createAccessControl` du plugin `admin` de better-auth plutôt que
// sur une table de rôles maison. Le plugin apporte le modèle
// ressource × action, la création de comptes, `setRole`, `removeUser` et —
// ce qui compte le plus pour l'interface — `checkRolePermission`, SYNCHRONE
// côté client : un bouton interdit se masque sans aller-retour serveur.
//
// **Des rôles, pas des locataires.** Une installation Noddle est UNE
// organisation. Tout le monde voit tout ; tout le monde ne fait pas tout.
// Aucune requête ne porte donc de prédicat d'appartenance, et c'est délibéré :
// des permissions par projet s'ajouteraient plus tard sans rien réécrire,
// alors que l'inverse imposerait de reprendre chaque lecture du produit.
//
// Ce fichier est PUR — aucun accès base, aucun import serveur — parce qu'il
// est chargé des deux côtés. C'est aussi ce qui le rend extractible le jour
// où RBAC devient le palier payant qu'il est censé être.

import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

/**
 * Les ressources de Noddle et ce qu'on peut leur faire.
 *
 * Découpées par CONSÉQUENCE, pas par table. `deploy` et `delete` vivent sur la
 * même ressource mais ne s'accordent pas ensemble : déployer se rattrape par
 * un rollback, supprimer un serveur non. C'est ce qui sépare `deployer`
 * d'`admin`.
 *
 * `envVar` est isolé des services alors qu'il en dépend, parce que les valeurs
 * y sont chiffrées et qu'y accéder revient à lire les secrets de production.
 * Quelqu'un qui doit pouvoir livrer n'a pas à les voir.
 */
export const statement = {
  ...defaultStatements,
  backup: ["read", "create", "restore"],
  database: ["read", "create", "delete", "attach"],
  envVar: ["read", "write"],
  notification: ["read", "manage"],
  server: ["read", "create", "delete"],
  service: ["read", "create", "deploy", "rollback", "delete"],
} as const;

export const ac = createAccessControl(statement);

/** Lecture seule, logs compris. Le rôle par défaut d'un compte créé. */
export const viewer = ac.newRole({
  backup: ["read"],
  database: ["read"],
  notification: ["read"],
  server: ["read"],
  service: ["read"],
});

/**
 * Livrer et exploiter, sans pouvoir casser ce qui n'est pas rattrapable.
 *
 * Déployer, revenir en arrière, sauvegarder. PAS de restauration — elle est la
 * seule opération irréversible du produit — pas de secrets, pas de
 * suppression, pas de serveurs.
 */
export const deployer = ac.newRole({
  backup: ["read", "create"],
  database: ["read"],
  notification: ["read"],
  server: ["read"],
  service: ["read", "deploy", "rollback"],
});

/** Tout sur l'infrastructure, plus la gestion des comptes. */
export const admin = ac.newRole({
  ...adminAc.statements,
  backup: ["read", "create", "restore"],
  database: ["read", "create", "delete", "attach"],
  envVar: ["read", "write"],
  notification: ["read", "manage"],
  server: ["read", "create", "delete"],
  service: ["read", "create", "deploy", "rollback", "delete"],
});

/**
 * Identique à `admin` aujourd'hui.
 *
 * Il existe quand même, et pas par symétrie : c'est le compte créé à
 * l'installation, celui qu'on refusera de rétrograder ou de supprimer. Sans
 * un rôle qui le distingue, un administrateur pourrait retirer le dernier
 * accès de l'installation — y compris le sien — et personne ne pourrait plus
 * y entrer.
 */
export const owner = admin;

export const roles = { admin, deployer, owner, viewer };

export type RoleName = keyof typeof roles;

/** L'ordre d'affichage, du plus faible au plus fort. Jamais une hiérarchie de
 *  décision : c'est `hasPermission` qui tranche, pas une comparaison d'index. */
export const ROLE_ORDER: RoleName[] = ["viewer", "deployer", "admin", "owner"];

export const ROLE_LABELS: Record<RoleName, string> = {
  admin: "Admin",
  deployer: "Operator",
  owner: "Owner",
  viewer: "Viewer",
};

/**
 * Ce que le rôle DONNE, en une phrase.
 *
 * Écrites ici et pas dans le composant, juste sous les tables de permissions
 * qu'elles résument : accorder un rôle sans savoir ce qu'il ouvre est le seul
 * vrai risque de cet écran, et une description qui vit loin de la règle qu'elle
 * décrit finit toujours par mentir. Modifier un `newRole` ci-dessus sans
 * toucher la ligne correspondante ici doit se voir à la relecture.
 */
export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  admin: "Full access to infrastructure, secrets and accounts.",
  deployer:
    "Deploy, roll back, run backups. No secrets, no deletion, no restore.",
  owner: "Same as admin, and cannot be removed by an admin.",
  viewer: "Reads everything, services, logs, backups. Changes nothing.",
};
