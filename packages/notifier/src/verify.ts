// tier: pure
//   bun  run packages/notifier/src/verify.ts
//   node packages/notifier/src/verify.ts
import { createServer } from "node:http";
import type { Server } from "node:http";

import { check, cleanup, runVerify, suite } from "@noddle/testing";

import { buildPayload, deliver, eventLabel, isFailure } from "#index";
import type { NotificationEvent } from "#index";

interface Received {
  body: string;
  contentType?: string;
  method: string;
}

const received: Received[] = [];
let mode: "hang" | "ok" | "refuse" | "revoked" = "ok";

function start(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        received.push({
          body,
          contentType: req.headers["content-type"],
          method: req.method ?? "",
        });
        if (mode === "hang") {
          // We never respond: this is the case of a recipient that
          // accepts the connection then goes quiet, which only a timeout
          // catches.
          return;
        }
        if (mode === "revoked") {
          res.writeHead(404).end("Unknown Webhook");
          return;
        }
        if (mode === "refuse") {
          res.writeHead(401).end("invalid token");
          return;
        }
        res.writeHead(204).end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, server });
    });
  });
}

const event: NotificationEvent = {
  detail: "build failed: exit 1",
  resource: "api",
  type: "deploy_failed",
  url: "https://noddle.example/",
};

await runVerify("notifications", async () => {
  const { port, server } = await start();
  cleanup(() => {
    server.close();
  });
  const base = `http://127.0.0.1:${port}`;

  await suite("payload shapes", () => {
    const discord = buildPayload("discord", event) as {
      embeds: { color: number; title: string }[];
    };
    check(
      "Discord: titled embed, failure color",
      discord.embeds[0]?.title === "Deploy failed — api" && discord.embeds[0]?.color === 0xd1_3d_3d,
      JSON.stringify(discord).slice(0, 120),
    );

    const success = buildPayload("discord", {
      resource: "api",
      type: "deploy_succeeded",
    }) as { embeds: { color: number }[] };
    check(
      "Discord: distinct color for a success",
      success.embeds[0]?.color === 0x2e_9e_4f,
      "same color for a success and a failure",
    );

    const slack = buildPayload("slack", event) as { text: string };
    check(
      "Slack: plain text, mrkdwn-formatted link",
      slack.text.includes("Deploy failed — api") &&
        slack.text.includes("<https://noddle.example/|"),
      slack.text,
    );

    const raw = buildPayload("webhook", event) as Record<string, unknown>;
    check(
      "webhook: raw structured form, not formatted for display",
      raw.type === "deploy_failed" && raw.failure === true && Boolean(raw.at),
      JSON.stringify(raw),
    );

    // A success must not be announced as a failure.
    check(
      "isFailure distinguishes a revert from a success",
      isFailure("watch_reverted") && !isFailure("deploy_succeeded"),
      "isFailure is inconsistent",
    );

    // The two forms of rollback stay DISTINCT: their difference is what
    // decides the trust placed in the tool.
    check(
      '"reverted by Swarm" and "reverted by monitoring" are distinct',
      eventLabel("deploy_reverted") !== eventLabel("watch_reverted"),
      "the two forms of rollback carry the same label",
    );
  });

  await suite("a delivery that succeeds", async () => {
    mode = "ok";
    received.length = 0;
    const r = await deliver({ kind: "discord", url: base }, event);
    check(`delivery succeeded: HTTP ${r.status}`, r.ok && r.status === 204, JSON.stringify(r));
    const [got] = received;
    check(
      "received as POST with JSON content-type",
      got?.method === "POST" && Boolean(got.contentType?.includes("application/json")),
      JSON.stringify(got),
    );
    check(
      "the body received on the other end matches what was built",
      Boolean(got && JSON.parse(got.body).embeds[0].title.includes("api")),
      "the received body doesn't match",
    );
  });

  // The heart of the matter: a revoked Discord webhook responds 404
  // WITHOUT the request failing in the network sense. Concluding from the
  // mere fact that `fetch` succeeded would reproduce the error this
  // project refuses elsewhere: inferring success from an exit code.
  await suite("failure paths", async () => {
    mode = "revoked";
    let r = await deliver({ kind: "discord", url: base }, event);
    check(
      `revoked webhook detected: ${r.error?.slice(0, 40)}`,
      !r.ok && r.status === 404,
      JSON.stringify(r),
    );

    mode = "refuse";
    r = await deliver({ kind: "slack", url: base }, event);
    check("refusing recipient detected (401)", !r.ok && r.status === 401, JSON.stringify(r));

    // Nonexistent host: network failure, no status.
    r = await deliver({ kind: "webhook", url: "https://hote-qui-nexiste-pas.invalid/x" }, event);
    check(
      `unreachable host reported without status: ${r.error?.slice(0, 40) ?? "?"}`,
      Boolean(!(r.ok || r.status) && r.error),
      JSON.stringify(r),
    );
  });

  await suite("the URL never leaks", async () => {
    // It's a bearer credential — whoever holds it can post to the channel
    // — and this message ends up in a column displayed on screen.
    const secret = "https://hooks.example.invalid/tres-secret-abc123";
    const r = await deliver({ kind: "discord", url: secret }, event);
    check(
      "the channel URL doesn't leak into the error message",
      !r.error?.includes("tres-secret-abc123"),
      "DANGER: the channel URL appears in the error message",
    );
  });

  await suite("never throw", async () => {
    // A delivery must not make the deployment that triggered it fail.
    let threw = false;
    try {
      await deliver({ kind: "webhook", url: "pas-une-url" }, event);
    } catch {
      threw = true;
    }
    check(
      "deliver never throws, even on an invalid URL",
      !threw,
      "deliver threw — a broken channel would fail the calling job",
    );
  });
});
