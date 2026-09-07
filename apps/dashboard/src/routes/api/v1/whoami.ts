import { createFileRoute } from "@tanstack/react-router";

import { resolveToken } from "@/lib/token-auth.server";

const NO_STORE = { "cache-control": "no-store" };

export const Route = createFileRoute("/api/v1/whoami")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const actor = await resolveToken(request);
        if (!actor) {
          return Response.json(
            {
              error: "unauthorized",
              message:
                "Send a Noddle token as `Authorization: Bearer noddle_pat_…`.",
            },
            {
              headers: {
                ...NO_STORE,
                "www-authenticate": 'Bearer realm="noddle"',
              },
              status: 401,
            }
          );
        }

        return Response.json(
          {
            email: actor.email,
            role: actor.role,
            scopes: actor.scopes,
            token: { id: actor.tokenId, name: actor.tokenName },
            userId: actor.userId,
          },
          { headers: NO_STORE }
        );
      },
    },
  },
});
