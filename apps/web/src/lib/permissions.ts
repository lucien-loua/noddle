import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

/**
 * Noddle's resources and what can be done to them.
 *
 * Split by CONSEQUENCE, not by table. `deploy` and `delete` live on the
 * same resource but are never granted together: a deploy can be undone
 * with a rollback, deleting a server cannot. That's what separates
 * `deployer` from `admin`.
 *
 * `envVar` is isolated from services even though it depends on them,
 * because its values are encrypted and accessing it amounts to reading
 * production secrets. Someone who needs to be able to deploy doesn't need
 * to see them.
 */
export const statement = {
  ...defaultStatements,

  /**
   * Read the audit log. No write: nobody writes it by hand,
   * `requirePermission` takes care of that — and no delete, because a log
   * an administrator can erase proves nothing.
   */
  audit: ["read"],
  backup: ["read", "create", "restore"],

  /**
   * Act on a container, split by CONSEQUENCE rather than by command.
   *
   * `operate` covers start, stop, restart — all reversible. `delete`
   * removes the container, which is not reversible: it's the same
   * boundary that separates `deployer` from `admin` everywhere else.
   *
   * A resource separate from `service`: the Containers page ALSO shows
   * what Noddle hasn't deployed, so being able to touch it isn't the same
   * as being able to deploy.
   */
  /**
   * `operate` — start/stop/restart. `delete` — remove the container.
   * `shell` — interactive `docker exec` into a container (terminal WS).
   * Separate from `operate`: a restart is one click; a shell is an open
   * session on the machine's workload.
   */
  container: ["operate", "delete", "shell"],

  /**
   * `operate` covers start, stop, restart — the same split and the same
   * reasoning as `container: operate`: it's reversible, unlike `delete`.
   * Built on the Swarm service that `provisionDatabase` already sets up —
   * `scaleService` and `restartService` only need a name, the same
   * mechanism as for a service. No `deploy` action: a database has
   * neither a build method nor a versioned image in this product, there's
   * nothing to rebuild.
   */
  database: ["read", "create", "delete", "attach", "operate"],
  envVar: ["read", "write"],

  /**
   * Update Noddle ITSELF. A resource of its own, not an action of
   * `server`: it's not a single machine being touched but the entire
   * installation — the control plane restarts, migrations run, and a
   * failure can't be recovered from the very screen that was just lost.
   *
   * No `read`: all four roles are allowed to see the running version, so
   * a guard wouldn't refuse anyone and would only write one audit line per
   * page view — that's exactly how /audit would bury its own signal.
   * Reading goes through `requireSession`, the same trade-off as
   * `server: read` for disk usage breakdown.
   */
  installation: ["update"],
  notification: ["read", "manage"],

  /**
   * External registries. A resource of its own, same reasoning as
   * `sshKey`: the row carries a password that grants access to publish
   * images under the installation's identity. `create` also covers
   * updating, as everywhere here — it's the same form.
   */
  registry: ["read", "create", "delete"],

  // `update` covers settings for the machine itself — for now, only the
  // prune switch. Separate from `create`/`delete`: adding or removing a
  // server touches the cluster topology, adjusting its prune setting
  // doesn't.
  //
  // `shell` is an interactive SSH session on the target server. Not
  // granted to deployer: a host shell is the installation's strongest
  // live access, closer to `sshKey` than to a reversible restart.
  server: ["read", "create", "delete", "update", "shell"],
  service: ["read", "create", "deploy", "rollback", "delete"],

  /**
   * The key library. A resource SEPARATE from `server`, for the same
   * reason `envVar` is separate from `service`: a private key opens up
   * machines AND private repositories, it's the product's strongest
   * secret. Someone who needs to be able to deploy, or even add a
   * machine, doesn't need to read it.
   *
   * No `update`: renaming has no value, and replacing a key's value under
   * servers that use it would silently change their access. We only
   * create and delete.
   */
  sshKey: ["read", "create", "delete"],
} as const;

export const ac = createAccessControl(statement);

/** Read-only, logs included. The default role for a newly created account. */
export const viewer = ac.newRole({
  backup: ["read"],
  database: ["read"],
  notification: ["read"],
  server: ["read"],
  service: ["read"],
});

/**
 * Deploy and operate, without being able to break what can't be undone.
 *
 * Deploy, roll back, back up. NO restore — it's the product's only
 * irreversible operation — no secrets, no deletion, no servers.
 */
export const deployer = ac.newRole({
  backup: ["read", "create"],
  // Restarting a misbehaving service is part of operating it; deleting a
  // container is not. Shell into a container is part of operating it —
  // scoped to that workload, not a host login.
  container: ["operate", "shell"],
  database: ["read", "operate"],
  notification: ["read"],
  server: ["read"],
  service: ["read", "deploy", "rollback"],
});

/** Everything on infrastructure, plus account management. */
export const admin = ac.newRole({
  ...adminAc.statements,
  // Neither `viewer` nor `deployer`: the log shows what OTHERS do,
  // including their denials. It's a matter of administration, not
  // operations.
  audit: ["read"],
  backup: ["read", "create", "restore"],
  container: ["operate", "delete", "shell"],
  database: ["read", "create", "delete", "attach", "operate"],
  envVar: ["read", "write"],
  // Neither `viewer` nor `deployer`: updating restarts the control plane
  // and runs migrations. It's administration of the installation, not
  // operations — and a `deployer` who deploys all day has no reason to be
  // able to change Noddle out from under their own feet.
  installation: ["update"],
  notification: ["read", "manage"],
  registry: ["read", "create", "delete"],
  server: ["read", "create", "delete", "update", "shell"],
  service: ["read", "create", "deploy", "rollback", "delete"],
  sshKey: ["read", "create", "delete"],
});

/**
 * Identical to `admin` today.
 *
 * It exists anyway, and not for symmetry: it's the account created at
 * installation, the one we'll refuse to demote or delete. Without a role
 * that distinguishes it, an administrator could remove the installation's
 * last access — including their own — and nobody could get back in.
 */
export const owner = admin;

export const roles = { admin, deployer, owner, viewer };

export type RoleName = keyof typeof roles;

/** The display order, from weakest to strongest. Never a decision
 *  hierarchy: `hasPermission` is what decides, not an index comparison. */
export const ROLE_ORDER: RoleName[] = ["viewer", "deployer", "admin", "owner"];

export type Statement = typeof statement;
export type PermissionResource = keyof Statement;
export type PermissionAction<R extends PermissionResource> =
  Statement[R][number];

/** A permission: a resource and one of ITS actions, not just any action. */
export type Permission = {
  [R in PermissionResource]: { action: PermissionAction<R>; resource: R };
}[PermissionResource];

/**
 * Pure permission check. Single seam for server guards, UI courtesy, and
 * verify-permissions — all three must answer the same question the same way.
 *
 * Unknown / missing roles deny. A corrupted role string in the database must
 * not unlock anything and must not throw (that would 500 a page).
 */
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

/** True when every product role is granted this permission. */
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

/**
 * What the role GRANTS, in one sentence.
 *
 * Written here rather than in the component, right below the permission
 * tables they summarize: granting a role without knowing what it unlocks
 * is this screen's only real risk, and a description that lives far from
 * the rule it describes always ends up lying. Modifying a `newRole` above
 * without touching the corresponding line here should be visible on review.
 */
export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  admin: "Full access to infrastructure, secrets and accounts.",
  deployer:
    "Deploy, roll back, run backups, shell into containers. No host shell, secrets, deletion, or restore.",
  owner: "Same as admin, and cannot be removed by an admin.",
  viewer: "Reads everything, services, logs, backups. Changes nothing.",
};
