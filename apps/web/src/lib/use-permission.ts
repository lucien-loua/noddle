import {
  can,
  type PermissionAction,
  type PermissionResource,
  type RoleName,
} from "@/lib/permissions";

export function useCan<R extends PermissionResource>(
  role: RoleName | null | undefined,
  resource: R,
  action: PermissionAction<R>
): boolean {
  return can(role, resource, action);
}
