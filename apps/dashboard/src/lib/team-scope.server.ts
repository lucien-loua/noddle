import { member } from "@noddle/db/schema";
import { eq } from "drizzle-orm";

import type { Session } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { seesWholeInstallation } from "@/lib/permissions";
import { requireSession } from "@/lib/session.server";
import type { SwarmNames } from "@/lib/swarm-ownership";
import { swarmNamesOfTeam } from "@/lib/team-queries.server";

export class NoActiveTeamError extends Error {
  constructor() {
    super("This account belongs to no team. Ask an admin to add you to one.");
    this.name = "NoActiveTeamError";
  }
}

export async function activeTeamId(): Promise<string> {
  const session = await requireSession();
  return await teamOfSession(session);
}

export async function teamOfSession(session: Session): Promise<string> {
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

export async function swarmScopeOf(
  session: Session
): Promise<SwarmNames | null> {
  if (seesWholeInstallation(session.user.role)) {
    return null;
  }
  return await swarmNamesOfTeam(db, await teamOfSession(session));
}
