import { deployments } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { ApiClientError } from "@/lib/api-errors";
import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";
import { readArchive } from "@/lib/log-archive.server";
import { logHub } from "@/lib/redis.server";

const TERMINAL = new Set([
  "succeeded",
  "failed",
  "rolled_back",
  "reverted_by_watch",
]);

export const Route = createFileRoute("/api/v1/deployments/$id/logs")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        withToken(
          request,
          { action: "read", resource: "service" },
          async () => {
            const row = await db.query.deployments.findFirst({
              where: eq(deployments.id, params.id),
            });
            if (!row) {
              throw new ApiClientError(
                404,
                "not_found",
                "No deployment with that id."
              );
            }

            const archive = await readArchive(row.id);
            if (archive.kind === "text") {
              return {
                done: TERMINAL.has(row.status),
                id: row.id,
                log: archive.text,
                source: "archive",
                status: row.status,
              };
            }

            const buffered = await logHub.backlog(row.id);
            const log = buffered
              .map((entry) =>
                entry.message.type === "chunk" ? entry.message.data : ""
              )
              .join("");

            return {
              done: TERMINAL.has(row.status),
              id: row.id,
              log,
              source: buffered.length > 0 ? "buffer" : "none",
              status: row.status,
            };
          }
        ),
    },
  },
});
