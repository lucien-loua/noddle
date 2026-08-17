import { auditLog } from "@noddle/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { desc } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { runRead } from "@/lib/permission.server";

/** Enough to answer "what happened recently", with no pagination — which
 *  would be one more screen for a question rarely asked. */
const LIMIT = 200;

export interface AuditRow {
  action: string;
  actorEmail: string;
  createdAt: string;
  id: string;
  ipAddress: string | null;
  outcome: "allowed" | "denied";
  resource: string;
  role: string | null;
}

export const getAuditLog = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuditRow[]> =>
    runRead({
      permission: { action: "read", resource: "audit" },
      read: async () => {
        const rows = await db.query.auditLog.findMany({
          limit: LIMIT,
          orderBy: desc(auditLog.createdAt),
        });
        return rows.map((r) => ({
          action: r.action,
          actorEmail: r.actorEmail,
          createdAt: r.createdAt.toISOString(),
          id: r.id,
          ipAddress: r.ipAddress,
          outcome: r.outcome,
          resource: r.resource,
          role: r.role,
        }));
      },
    })
);
