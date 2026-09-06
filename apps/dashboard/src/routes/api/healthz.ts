import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/healthz")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          {
            commit: process.env.NODDLE_COMMIT || null,
            ok: true,
            version: process.env.NODDLE_VERSION || null,
          },
          { headers: { "cache-control": "no-store" } }
        ),
    },
  },
});
