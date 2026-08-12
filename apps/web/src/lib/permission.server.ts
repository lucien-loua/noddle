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
 * found, confirm-name mismatch). Successes are written by `runGuarded`
 * once the act has finished, and by nothing else.
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
 * The one way to run a restricted GET server function.
 *
 * Same permission gate as `runGuarded`, without the mutation audit line:
 * logging every successful read of env vars or the audit log would bury
 * the signal those screens exist to show. Denials still go through
 * `requirePermission` → `record`.
 *
 * Use `requireSession` alone when every signed-in role may see the data
 * (dashboard rows, deployment history). Use `runRead` when at least one
 * role lacks the permission — the verify-permissions restricted markers
 * exist to catch the gap between those two.
 */
export async function runRead<TRow = undefined, TResult = void>(opts: {
  load?: () => Promise<TRow | null | undefined>;
  notFoundMessage?: string;
  permission: Permission;
  read: (ctx: { row: TRow; session: Session }) => TResult | Promise<TResult>;
}): Promise<TResult> {
  const session = await requirePermission(opts.permission);

  let row = undefined as TRow;
  if (opts.load) {
    const loaded = (await opts.load()) ?? null;
    if (loaded === null) {
      throw new Error(opts.notFoundMessage ?? "not found");
    }
    row = loaded;
  }

  return await opts.read({ row, session });
}

export interface AuditTarget {
  id: string;
  name?: string | null;
}

/**
 * The one way to run a mutating server function.
 *
 * Permission, optional row load, optional confirm-name, the act, then the
 * audit line — in that order. The audit write is NOT exported: this
 * function is the only caller, so a handler cannot perform an act and
 * forget to record it. That is the whole point; before this, every
 * mutation but two wrote nothing on success.
 *
 * Three shapes, one interface:
 * - `load` + `target(row)` — act on an existing row.
 * - no `load`, `target({ result })` — creation; the object only exists
 *   once `run` has produced it.
 * - neither — an act with no single object (`saveEnvVars` writes many
 *   rows, `startUpdate` acts on the installation). Recorded with a null
 *   `resourceId`, which is still a line saying who did what and when.
 */
export async function runGuarded<TRow = undefined, TResult = void>(opts: {
  confirmName?: { expected: (row: TRow) => string; typed: string };
  load?: () => Promise<TRow | null | undefined>;
  notFoundMessage?: string;
  permission: Permission;
  run: (ctx: { row: TRow; session: Session }) => Promise<TResult>;
  target?: (ctx: { result: TResult; row: TRow }) => AuditTarget | null;
}): Promise<TResult> {
  const session = await requirePermission(opts.permission);

  let row = undefined as TRow;
  if (opts.load) {
    const loaded = (await opts.load()) ?? null;
    if (loaded === null) {
      throw new Error(opts.notFoundMessage ?? "not found");
    }
    row = loaded;
  }

  if (opts.confirmName) {
    const expected = opts.confirmName.expected(row);
    if (opts.confirmName.typed !== expected) {
      throw new Error(
        `the name you typed does not match "${expected}" — cancelled`
      );
    }
  }

  const result = await opts.run({ row, session });
  const target = opts.target?.({ result, row }) ?? null;
  await record(session, opts.permission, "allowed", {
    resourceId: target === null ? null : target.id,
    resourceName: target?.name ?? null,
  });
  return result;
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
