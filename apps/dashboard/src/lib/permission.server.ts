import { auditLog } from "@noddle/db/schema";
import {
  getRequestHeaders,
  setResponseStatus,
} from "@tanstack/react-start/server";

import type { Session } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { can } from "@/lib/permissions";
import type { Permission } from "@/lib/permissions";
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

export async function requirePermission(
  permission: Permission
): Promise<Session> {
  const session = await requireSession();
  const allowed = can(roleOf(session), permission.resource, permission.action);

  if (!allowed) {
    await record(session, permission, "denied");
    setResponseStatus(403);
    throw new ForbiddenError(
      `Action refused: your role does not allow "${permission.action}" on ${permission.resource}.`
    );
  }
  return session;
}

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
        `the name you typed does not match "${expected}": cancelled`
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
  } catch {}

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
  } catch (error) {
    process.stderr.write(
      `audit log write failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}
