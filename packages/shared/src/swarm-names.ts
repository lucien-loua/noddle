/** What Swarm accepts. Measured, not read from documentation. */
export const SWARM_NAME_MAX = 63;

/** 8 hex digits of a UUID: enough to disambiguate, short enough to fit. */
function shortId(id: string): string {
  return id.replaceAll("-", "").slice(0, 8);
}

/**
 * Name of a database's service AND volume.
 *
 * The prefix goes from `noddle-db-` to `ndb-`: `noddle-db-` (10) + a name
 * of up to 48 (the maximum from `serviceNameSchema`) + `-` + 8 = 67, four
 * too many. Shortening the PREFIX rather than the name keeps the 48-char
 * limit intact — no reduction to the product — and gives 4 + 48 + 1 + 8 =
 * 61, under the ceiling with room to spare.
 *
 * The distinct prefix is also what makes the two schemes visually
 * distinguishable: `noddle-db-*` is a database from before this fix,
 * `ndb-*` one from after.
 */
export function newDatabaseSwarmName(db: { id: string; name: string }): string {
  return `ndb-${db.name}-${shortId(db.id)}`;
}

/**
 * A stack's namespace. Its Swarm services will be `<returned>_<key>` and
 * its default network `<returned>_default` — both count toward the 63.
 *
 * The readable name is TRUNCATED to 20 characters, which would be
 * unacceptable for a service but isn't here: uniqueness is carried by the
 * 8 hex digits, not by the readable part. This is the reverse of the
 * `project-environment-service` case ruled out for services, where
 * truncating would have removed the very discriminant.
 *
 * 20 + 1 + 8 = 29, which leaves 34 characters for `_<key>` — i.e. a
 * compose service key up to 33 characters. Without truncation, a name of
 * 48 would have left only 5, and `_default` alone needs 8.
 */
export function newStackSwarmName(stack: { id: string; name: string }): string {
  return `${stack.name.slice(0, 20)}-${shortId(stack.id)}`;
}

/**
 * Swarm service name for an application Service.
 *
 * Readable name in front, eight hex digits of the UUID behind — same
 * formula the worker has always written. Lives here so the web never
 * copies it (inventory, terminal, labels).
 */
export function swarmServiceName(service: {
  id: string;
  name: string;
}): string {
  return `${service.name}-${shortId(service.id)}`;
}
