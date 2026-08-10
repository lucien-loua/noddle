//   bun  run packages/notifier/src/verify.ts
//   node packages/notifier/src/verify.ts
import { createServer, type Server } from "node:http";
import {
  buildPayload,
  deliver,
  eventLabel,
  isFailure,
  type NotificationEvent,
} from "#index";

const runtime =
  typeof globalThis.Bun === "undefined"
    ? `Node ${process.version}`
    : `Bun ${globalThis.Bun.version}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

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

console.log(`\n\x1b[1m${runtime} — notifications\x1b[0m`);

const { port, server } = await start();
const base = `http://127.0.0.1:${port}`;

try {
  // ── 1. Payload shapes ────────────────────────────────────────────────────
  const discord = buildPayload("discord", event) as {
    embeds: { color: number; title: string }[];
  };
  if (
    discord.embeds[0]?.title === "Deploy failed — api" &&
    discord.embeds[0]?.color === 0xd1_3d_3d
  ) {
    ok("Discord: titled embed, failure color");
  } else {
    ko(`Discord: ${JSON.stringify(discord).slice(0, 120)}`);
  }

  const success = buildPayload("discord", {
    resource: "api",
    type: "deploy_succeeded",
  }) as { embeds: { color: number }[] };
  if (success.embeds[0]?.color === 0x2e_9e_4f) {
    ok("Discord: distinct color for a success");
  } else {
    ko("Discord: same color for a success and a failure");
  }

  const slack = buildPayload("slack", event) as { text: string };
  if (
    slack.text.includes("Deploy failed — api") &&
    slack.text.includes("<https://noddle.example/|")
  ) {
    ok("Slack: plain text, mrkdwn-formatted link");
  } else {
    ko(`Slack: ${slack.text}`);
  }

  const raw = buildPayload("webhook", event) as Record<string, unknown>;
  if (raw.type === "deploy_failed" && raw.failure === true && raw.at) {
    ok("webhook: raw structured form, not formatted for display");
  } else {
    ko(`webhook: ${JSON.stringify(raw)}`);
  }

  // A success must not be announced as a failure.
  if (isFailure("watch_reverted") && !isFailure("deploy_succeeded")) {
    ok("isFailure distinguishes a revert from a success");
  } else {
    ko("isFailure is inconsistent");
  }

  // The two forms of rollback stay DISTINCT: their difference is what
  // decides the trust placed in the tool.
  if (eventLabel("deploy_reverted") === eventLabel("watch_reverted")) {
    ko("the two forms of rollback carry the same label");
  } else {
    ok('"reverted by Swarm" and "reverted by monitoring" are distinct');
  }

  // ── 2. A delivery that succeeds ──────────────────────────────────────────
  mode = "ok";
  received.length = 0;
  let r = await deliver({ kind: "discord", url: base }, event);
  if (r.ok && r.status === 204) {
    ok(`delivery succeeded: HTTP ${r.status}`);
  } else {
    ko(`delivery: ${JSON.stringify(r)}`);
  }
  const [got] = received;
  if (got?.method === "POST" && got.contentType?.includes("application/json")) {
    ok("received as POST with JSON content-type");
  } else {
    ko(`received: ${JSON.stringify(got)}`);
  }
  if (got && JSON.parse(got.body).embeds[0].title.includes("api")) {
    ok("the body received on the other end matches what was built");
  } else {
    ko("the received body doesn't match");
  }

  // ── 3. Failure paths — the heart of the matter ───────────────────────────
  // A revoked Discord webhook responds 404 WITHOUT the request failing in
  // the network sense. Concluding from the mere fact that `fetch` succeeded
  // would reproduce the error this project refuses elsewhere: inferring
  // success from an exit code.
  mode = "revoked";
  r = await deliver({ kind: "discord", url: base }, event);
  if (!r.ok && r.status === 404) {
    ok(`revoked webhook detected: ${r.error?.slice(0, 40)}`);
  } else {
    ko(`404 not detected: ${JSON.stringify(r)}`);
  }

  mode = "refuse";
  r = await deliver({ kind: "slack", url: base }, event);
  if (!r.ok && r.status === 401) {
    ok("refusing recipient detected (401)");
  } else {
    ko(`401 not detected: ${JSON.stringify(r)}`);
  }

  // Nonexistent host: network failure, no status.
  r = await deliver(
    { kind: "webhook", url: "https://hote-qui-nexiste-pas.invalid/x" },
    event
  );
  if (!(r.ok || r.status) && r.error) {
    ok(`unreachable host reported without status: ${r.error.slice(0, 40)}`);
  } else {
    ko(`unreachable host: ${JSON.stringify(r)}`);
  }

  // ── 4. The URL must NEVER leak into the error message ────────────────────
  // It's a bearer credential — whoever holds it can post to the channel —
  // and this message ends up in a column displayed on screen.
  const secret = "https://hooks.example.invalid/tres-secret-abc123";
  r = await deliver({ kind: "discord", url: secret }, event);
  if (r.error?.includes("tres-secret-abc123")) {
    ko("DANGER: the channel URL appears in the error message");
  } else {
    ok("the channel URL doesn't leak into the error message");
  }

  // ── 5. Never throw ────────────────────────────────────────────────────────
  // A delivery must not make the deployment that triggered it fail.
  let threw = false;
  try {
    await deliver({ kind: "webhook", url: "pas-une-url" }, event);
  } catch {
    threw = true;
  }
  if (threw) {
    ko("deliver threw — a broken channel would fail the calling job");
  } else {
    ok("deliver never throws, even on an invalid URL");
  }
} catch (err) {
  ko(`exception: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.close();
}

console.log(`\n\x1b[1m${runtime} — passed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
