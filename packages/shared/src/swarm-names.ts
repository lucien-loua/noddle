export const SWARM_NAME_MAX = 63;

function shortId(id: string): string {
  return id.replaceAll("-", "").slice(0, 8);
}

function assertWithinSwarmLimit(kind: string, name: string): string {
  if (name.length > SWARM_NAME_MAX) {
    throw new Error(
      `${kind} name "${name}" is ${name.length} characters, over Swarm's ${SWARM_NAME_MAX}-character limit`
    );
  }
  return name;
}

export function newDatabaseSwarmName(db: { id: string; name: string }): string {
  return assertWithinSwarmLimit("database", `ndb-${db.name}-${shortId(db.id)}`);
}

export function newStackSwarmName(stack: { id: string; name: string }): string {
  return `${stack.name.slice(0, 20)}-${shortId(stack.id)}`;
}

export function swarmServiceName(service: {
  id: string;
  name: string;
}): string {
  return assertWithinSwarmLimit(
    "service",
    `${service.name}-${shortId(service.id)}`
  );
}
