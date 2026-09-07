import {
  idempotencyStore,
  readIdempotencyHeader,
} from "@/lib/idempotency.server";
import { recordAudit } from "@/lib/permission.server";
import type { PermissionResource } from "@/lib/permissions";
import { redis } from "@/lib/redis.server";
import { resolveToken, tokenCan } from "@/lib/token-auth.server";
import type { TokenActor } from "@/lib/token-auth.server";

const NO_STORE = Object.freeze({ "cache-control": "no-store" });
export interface ApiError {
  error: string;
  message: string;
}

export function apiError(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return Response.json({ error, message } satisfies ApiError, {
    headers: { ...NO_STORE, ...headers },
    status,
  });
}

interface Need {
  action: string;
  resource: PermissionResource;
}

const idempotency = idempotencyStore(redis);

export async function withToken(
  request: Request,
  need: Need,
  handler: (actor: TokenActor) => Promise<unknown>
): Promise<Response> {
  const actor = await resolveToken(request);
  if (!actor) {
    return apiError(
      401,
      "unauthorized",
      "Send a Noddle token as `Authorization: Bearer noddle_pat_…`.",
      { "www-authenticate": 'Bearer realm="noddle"' }
    );
  }

  if (!tokenCan(actor, need.resource, need.action)) {
    await recordAudit({
      action: need.action,
      actorEmail: actor.email,
      actorKind: "token",
      actorTokenId: actor.tokenId,
      actorTokenName: actor.tokenName,
      actorUserId: actor.userId,
      outcome: "denied",
      resource: need.resource,
      role: actor.role,
    });
    return apiError(
      403,
      "forbidden",
      `This token does not carry ${need.resource}:${need.action}.`
    );
  }

  const mutating = request.method !== "GET" && request.method !== "HEAD";
  const key = mutating ? readIdempotencyHeader(request) : null;
  if (key) {
    const previous = await idempotency.replay(actor.tokenId, key);
    if (previous) {
      return Response.json(previous.body, {
        headers: { ...NO_STORE, "idempotent-replay": "true" },
        status: previous.status,
      });
    }
  }

  try {
    const body = await handler(actor);
    if (mutating) {
      await recordAudit({
        action: need.action,
        actorEmail: actor.email,
        actorKind: "token",
        actorTokenId: actor.tokenId,
        actorTokenName: actor.tokenName,
        actorUserId: actor.userId,
        outcome: "allowed",
        resource: need.resource,
        role: actor.role,
      });
    }
    if (key) {
      await idempotency.remember(actor.tokenId, key, { body, status: 200 });
    }
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError(400, "request_failed", message);
  }
}
