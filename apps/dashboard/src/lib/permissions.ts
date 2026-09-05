import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

export const statement = {
  ...defaultStatements,

  audit: ["read"],
  backup: ["read", "create", "restore"],

  container: ["operate", "delete", "shell"],

  database: ["read", "create", "delete", "attach", "operate"],
  envVar: ["read", "write"],

  gitProvider: ["read", "create", "delete"],
  installation: ["update"],
  notification: ["read", "manage"],

  registry: ["read", "create", "delete"],

  server: ["read", "create", "delete", "update", "shell"],
  service: ["read", "create", "deploy", "rollback", "delete"],

  sshKey: ["read", "create", "delete"],
} as const;

export const ac = createAccessControl(statement);

export const viewer = ac.newRole({
  backup: ["read"],
  database: ["read"],
  notification: ["read"],
  server: ["read"],
  service: ["read"],
});

export const deployer = ac.newRole({
  backup: ["read", "create"],
  container: ["operate", "shell"],
  database: ["read", "operate"],
  notification: ["read"],
  server: ["read"],
  service: ["read", "deploy", "rollback"],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  audit: ["read"],
  backup: ["read", "create", "restore"],
  container: ["operate", "delete", "shell"],
  database: ["read", "create", "delete", "attach", "operate"],
  envVar: ["read", "write"],
  gitProvider: ["read", "create", "delete"],
  installation: ["update"],
  notification: ["read", "manage"],
  registry: ["read", "create", "delete"],
  server: ["read", "create", "delete", "update", "shell"],
  service: ["read", "create", "deploy", "rollback", "delete"],
  sshKey: ["read", "create", "delete"],
});

export const owner = admin;

export const roles = { admin, deployer, owner, viewer };

export type RoleName = keyof typeof roles;

export const ROLE_ORDER: RoleName[] = ["viewer", "deployer", "admin", "owner"];

export type Statement = typeof statement;
export type PermissionResource = keyof Statement;
export type PermissionAction<R extends PermissionResource> =
  Statement[R][number];

export type Permission = {
  [R in PermissionResource]: { action: PermissionAction<R>; resource: R };
}[PermissionResource];

export function can(
  role: RoleName | string | null | undefined,
  resource: PermissionResource,
  action: string
): boolean {
  if (!(role && role in roles)) {
    return false;
  }
  return roles[role as RoleName].authorize({
    [resource]: [action],
  }).success;
}

export function isPermissionUniversal(
  resource: PermissionResource,
  action: string
): boolean {
  return ROLE_ORDER.every((role) => can(role, resource, action));
}

export const ROLE_LABELS: Record<RoleName, string> = {
  admin: "Admin",
  deployer: "Operator",
  owner: "Owner",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  admin: "Full access to infrastructure, secrets and accounts.",
  deployer:
    "Deploy, roll back, run backups, shell into containers. No host shell, secrets, deletion, or restore.",
  owner: "Same as admin, and cannot be removed by an admin.",
  viewer: "Reads everything, services, logs, backups. Changes nothing.",
};
