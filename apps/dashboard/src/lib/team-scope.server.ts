import {
  databases,
  environments,
  member,
  projects,
  services,
} from "@noddle/db/schema";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

export class NoActiveTeamError extends Error {
  constructor() {
    super("This account belongs to no team. Ask an admin to add you to one.");
    this.name = "NoActiveTeamError";
  }
}

/**
 * The team every scoped read filters by. It comes from the session, never from
 * the caller, so a request cannot ask for another team's rows.
 */
export async function activeTeamId(): Promise<string> {
  const session = await requireSession();
  const fromSession = session.session.activeOrganizationId;
  if (fromSession) {
    return fromSession;
  }

  const [membership] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, session.user.id))
    .limit(1);
  if (!membership) {
    throw new NoActiveTeamError();
  }
  return membership.organizationId;
}

export function projectsOfTeam(teamId: string) {
  return db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.teamId, teamId));
}

export function environmentsOfTeam(teamId: string) {
  return db
    .select({ id: environments.id })
    .from(environments)
    .where(inArray(environments.projectId, projectsOfTeam(teamId)));
}

export async function inActiveTeamProjects() {
  return inArray(projects.id, projectsOfTeam(await activeTeamId()));
}

export async function inActiveTeamEnvironments() {
  return inArray(environments.id, environmentsOfTeam(await activeTeamId()));
}

export function databasesOfTeam(teamId: string) {
  return db
    .select({ id: databases.id })
    .from(databases)
    .where(inArray(databases.environmentId, environmentsOfTeam(teamId)));
}

export function servicesOfTeam(teamId: string) {
  return db
    .select({ id: services.id })
    .from(services)
    .where(inArray(services.environmentId, environmentsOfTeam(teamId)));
}
