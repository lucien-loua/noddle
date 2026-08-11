import { auditLog } from "@noddle/db/schema";
import {
  getRequestHeaders,
  setResponseStatus,
} from "@tanstack/react-start/server";
import type { Session } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { can, type Permission } from "@/lib/permissions";
import { requireSession } from "@/lib/session.server";

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

function roleOf(session: Session): string | null {
  return session.user.role ?? null;
}

/**
 * Requires a permission. Throws if it's missing.
 *
 * Decision goes through `can` — the same pure seam as `useCan` and
 * verify-permissions. better-auth still owns the session; it no longer
 * re-evaluates the product permission table for these guards.
 *
 * Hiding a button isn't a permission anyway: THIS check is, hiding is
 * merely a courtesy.
 *
 * Allowed attempts are NOT written here — a check that passes before the
 * handler body would log "allowed" for work that never happened (not
 * found, confirm-name mismatch). Successes go through `recordPerformed`
 * once the act finished, typically via `guardedMutation`.
 */
export async function requirePermission(
  permission: Permission
): Promise<Session> {
  const session = await requireSession();
  const allowed = can(roleOf(session), permission.resource, permission.action);

  if (!allowed) {
    // Denials are the useful half of the log — a log that only keeps what
    // succeeded never shows someone probing around.
    await record(session, permission, "denied");
    setResponseStatus(403);
    throw new ForbiddenError(
      `Action refused: your role does not allow "${permission.action}" on ${permission.resource}.`
    );
  }
  return session;
}

/**
 * Record that a mutating act actually completed, with its object.
 *
 * Call AFTER the handler succeeds. `guardedMutation` does this; hand-
 * written handlers that still call `requirePermission` alone should move
 * to `guardedMutation` so the object and the outcome stop drifting.
 */
export async function recordPerformed(
  session: Session,
  permission: Permission,
  target: { id: string; name?: string | null }
): Promise<void> {
  await record(session, permission, "allowed", {
    resourceId: target.id,
    resourceName: target.name ?? null,
  });
}

/**
 * The log does not record its OWN consultation, when it's authorized.
 *
 * Without this, every display of /audit writes a "read · audit" line, so
 * every reload writes one more. The log fills up with the trace of its
 * own reading, and since it only renders the last 200, a few refreshes
 * are enough to CHASE the real events out of the window. A log that
 * buries its own signal by being looked at is no longer useful.
 *
 * A DENIAL to read, however, stays logged: someone trying to reach a
 * screen they're not allowed to see is exactly what we want to capture.
 * The exclusion is therefore on the pair AND the outcome, not on the
 * resource alone.
 *
 * Deliberately narrow: `envVar: read` stays logged, because reading the
 * variables amounts to reading production secrets.
 */
function isSelfConsultation(
  permission: Permission,
  outcome: "allowed" | "denied"
): boolean {
  return (
    outcome === "allowed" &&
    permission.resource === "audit" &&
    permission.action === "read"
  );
}

async function record(
  session: Session,
  permission: Permission,
  outcome: "allowed" | "denied",
  target?: { resourceId: string | null; resourceName: string | null }
): Promise<void> {
  if (isSelfConsultation(permission, outcome)) {
    return;
  }
  let ipAddress: string | null = null;
  let userAgent: string | null = null;
  try {
    const headers = getRequestHeaders();
    ipAddress =
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      headers.get("x-real-ip") ??
      null;
    userAgent = headers.get("user-agent") ?? null;
  } catch {
    // outside a request context: the line is written anyway
  }

  try {
    await db.insert(auditLog).values({
      action: permission.action,
      actorEmail: session.user.email,
      actorUserId: session.user.id,
      ipAddress,
      outcome,
      resource: permission.resource,
      resourceId: target?.resourceId ?? null,
      resourceName: target?.resourceName ?? null,
      role: roleOf(session),
      userAgent,
    });
  } catch (err) {
    process.stderr.write(
      `audit log write failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}
