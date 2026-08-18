/**
 * biome-ignore-all lint/performance/noBarrelFile: drizzle({ schema }) requires the whole object
 *
 * The complete schema, in a single entry point.
 *
 * The only barrel file the repo knowingly accepts, for a mechanical reason:
 * `drizzle({ schema })` wants the ENTIRE object. Relations only resolve if
 * all tables are present together, so splitting it up per-use would break
 * `db.query`.
 */
export * from "#schema/audit";
export * from "#schema/auth";
export * from "#schema/backups";
export * from "#schema/databases";
export * from "#schema/deployments";
export * from "#schema/env-vars";
export * from "#schema/git-providers";
export * from "#schema/metrics";
export * from "#schema/notifications";
export * from "#schema/projects";
export * from "#schema/registries";
export * from "#schema/relations";
export * from "#schema/s3-destinations";
export * from "#schema/servers";
export * from "#schema/service-dependencies";
export * from "#schema/service-domains";
export * from "#schema/services";
export * from "#schema/ssh-keys";
export * from "#schema/stacks";
export * from "#schema/volume-backups";
