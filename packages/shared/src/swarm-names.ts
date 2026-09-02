export const SWARM_NAME_MAX = 63;

function shortId(id: string): string {
  return id.replaceAll("-", "").slice(0, 8);
}

export function newDatabaseSwarmName(db: { id: string; name: string }): string {
  return `ndb-${db.name}-${shortId(db.id)}`;
}

export function newStackSwarmName(stack: { id: string; name: string }): string {
  return `${stack.name.slice(0, 20)}-${shortId(stack.id)}`;
}

export function swarmServiceName(service: {
  id: string;
  name: string;
}): string {
  return `${service.name}-${shortId(service.id)}`;
}
