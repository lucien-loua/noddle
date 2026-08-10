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
 */
export async function requirePermission(
  permission: Permission
): Promise<Session> {
  const session = await requireSession();
  const allowed = can(roleOf(session), permission.resource, permission.action);

  // BEFORE throwing: an unlogged denial is precisely the one we'd want to
  // read back later. It's the useful half of the log — a log that only
  // keeps what succeeded never shows someone probing around.
  await record(session, permission, allowed ? "allowed" : "denied");

  if (!allowed) {
    // Without this, every denial returns a 500 — measured: `event.res.status`
    // is empty as long as nothing has set it, so TanStack Start's generic
    // catch falls back to its default. Set HERE, at the single point of
    // passage, rather than in each guarded function: otherwise `/audit`
    // would remain the only screen behaving differently — exactly the gap
    // already noted.
    setResponseStatus(403);
    throw new ForbiddenError(
      `Action refused: your role does not allow "${permission.action}" on ${permission.resource}.`
    );
  }
  return session;
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

/**
 * Writes the audit line. NEVER THROWS.
 *
 * Same rule as `notify`, and for the same reason: an incident in this
 * write must not turn a valid deployment into a failure. The try/catch is
 * set up ONCE here rather than copied at every call site.
 *
 * The trade-off is deliberate and worth stating: we'd rather lose an
 * audit line than block the action. This isn't the right call for every
 * product — a system where the audit trail is authoritative would refuse
 * the action — but here the table lives in the SAME Postgres as the
 * action itself, so an unreachable database fails both anyway. The
 * window where only the audit is lost is narrow, and the failure goes to
 * stderr rather than into silence.
 */
async function record(
  session: Session,
  permission: Permission,
  outcome: "allowed" | "denied"
): Promise<void> {
  if (isSelfConsultation(permission, outcome)) {
    return;
  }
  // The headers are ENRICHMENT, not the line itself. Reading them depends
  // on a request context; if it fails, we still want to know WHO
  // attempted WHAT. Fetching them in their own try/catch prevents an IP
  // address detail from making the entire event disappear — the silent
  // gap this log exists to avoid.
  let ipAddress: string | null = null;
  let userAgent: string | null = null;
  try {
    const headers = getRequestHeaders();
    // `x-forwarded-for` first: the web process sits behind Traefik, so
    // the socket address would always be the proxy's. The first element
    // of the list is the origin client.
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
      // COPIED, not joined: deleting an account must not erase the trace
      // of what it did.
      actorEmail: session.user.email,
      actorUserId: session.user.id,
      ipAddress,
      outcome,
      resource: permission.resource,
      role: roleOf(session),
      userAgent,
    });
  } catch (err) {
    process.stderr.write(
      `audit log write failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}
