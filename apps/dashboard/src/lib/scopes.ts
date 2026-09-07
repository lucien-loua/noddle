import { can, statement } from "@/lib/permissions";
import type { PermissionResource, RoleName } from "@/lib/permissions";

export type Scope = string;

export const ALL_SCOPES: Scope[] = Object.entries(statement)
  .flatMap(([resource, actions]) =>
    (actions as readonly string[]).map((action) => `${resource}:${action}`)
  )
  .toSorted();

const DESTRUCTIVE_SUFFIXES = new Set([
  "delete",
  "shell",
  "restore",
  "impersonate",
]);

export const DESTRUCTIVE_SCOPES: ReadonlySet<Scope> = new Set(
  ALL_SCOPES.filter((scope) =>
    DESTRUCTIVE_SUFFIXES.has(scope.split(":")[1] ?? "")
  )
);

export function isKnownScope(scope: string): boolean {
  return ALL_SCOPES.includes(scope);
}

export function splitScope(
  scope: Scope
): { action: string; resource: PermissionResource } | null {
  const [resource, action] = scope.split(":");
  if (!(resource && action) || !isKnownScope(scope)) {
    return null;
  }
  return { action, resource: resource as PermissionResource };
}

export function grantableBy(role: RoleName | string | null): Scope[] {
  return ALL_SCOPES.filter((scope) => {
    const parts = splitScope(scope);
    return parts ? can(role, parts.resource, parts.action) : false;
  });
}

export function narrowToRole(
  granted: readonly string[],
  role: RoleName | string | null
): Scope[] {
  const allowed = new Set(grantableBy(role));
  return granted.filter((scope) => allowed.has(scope)).toSorted();
}

export function tokenAllows(
  granted: readonly string[],
  role: RoleName | string | null,
  resource: PermissionResource,
  action: string
): boolean {
  return narrowToRole(granted, role).includes(`${resource}:${action}`);
}
