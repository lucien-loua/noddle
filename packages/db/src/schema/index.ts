/**
 * biome-ignore-all lint/performance/noBarrelFile: drizzle({ schema }) exige l'objet entier
 *
 * Le schéma complet, en un point d'entrée.
 *
 * Seul fichier tonneau assumé du dépôt, pour une raison mécanique :
 * `drizzle({ schema })` veut l'objet ENTIER. Les relations ne se résolvent que
 * si toutes les tables sont présentes ensemble, donc le découper à l'usage
 * casserait `db.query`.
 */
export * from "#schema/auth";
export * from "#schema/deployments";
export * from "#schema/env-vars";
export * from "#schema/projects";
export * from "#schema/relations";
export * from "#schema/servers";
export * from "#schema/services";
