import { member } from "@noddle/db/schema";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

export class NoActiveTeamError extends Error {
  constructor() {
    super("This account belongs to no team. Ask an admin to add you to one.");
    this.name = "NoActiveTeamError";
  }
}

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
