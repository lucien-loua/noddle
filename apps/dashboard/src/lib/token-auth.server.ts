import { apikey, user } from "@noddle/db/schema";
import { isWellFormedToken } from "@noddle/shared/api-token";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import type { PermissionResource } from "@/lib/permissions";
import { narrowToRole, permissionsToScopes } from "@/lib/scopes";

export interface TokenActor {
  email: string;
  role: string | null;
  scopes: string[];
  tokenId: string;
  tokenName: string;
  userId: string;
}

export function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return header.slice("bearer ".length).trim() || null;
}

export async function resolveToken(
  request: Request
): Promise<TokenActor | null> {
  const presented = bearerFrom(request);
  if (!presented || !isWellFormedToken(presented)) {
    return null;
  }

  const verified = await auth.api.verifyApiKey({ body: { key: presented } });
  if (!(verified.valid && verified.key)) {
    return null;
  }

  const [row] = await db
    .select({
      email: user.email,
      name: apikey.name,
      permissions: apikey.permissions,
      role: user.role,
      userId: user.id,
    })
    .from(apikey)
    .innerJoin(user, eq(user.id, apikey.referenceId))
    .where(eq(apikey.id, verified.key.id));

  if (!row) {
    return null;
  }

  const granted = permissionsToScopes(
    row.permissions ? JSON.parse(row.permissions) : null
  );

  return {
    email: row.email,
    role: row.role,
    scopes: narrowToRole(granted, row.role),
    tokenId: verified.key.id,
    tokenName: row.name ?? "unnamed",
    userId: row.userId,
  };
}

export function tokenCan(
  actor: TokenActor,
  resource: PermissionResource,
  action: string
): boolean {
  return actor.scopes.includes(`${resource}:${action}`);
}
