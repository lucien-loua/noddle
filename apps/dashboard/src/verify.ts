// tier: local
import { setTimeout as sleep } from "node:timers/promises";

import { createDatabase } from "@noddle/db";
import {
  account,
  deployments,
  environments,
  projects,
  servers,
  services,
  session,
  sshKeys,
  user,
} from "@noddle/db/schema";
import { DEPLOY_QUEUE_NAME, deployJobSchema } from "@noddle/deploy-contract";
import {
  encodeLogMessage,
  LOG_BUFFER_MAX_ENTRIES,
  LOG_BUFFER_TTL_SECONDS,
  LOG_PUBLISH_SCRIPT,
  logBufferKey,
  logChannel,
  logSeqKey,
} from "@noddle/shared/logs";
import type { LogMessage } from "@noddle/shared/logs";
import { devStack } from "@noddle/testing/dev-stack";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";

const DB_URL = devStack().databaseUrl;
const REDIS_URL = devStack().redisUrl;
const PORT = Number(process.env.PORT ?? 3311);
const BASE = `http://localhost:${PORT}`;

const EMAIL = "admin@noddle.test";
const PASSWORD = "a-reasonably-long-password";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \u001B[32m✓\u001B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \u001B[31m✗\u001B[0m ${m}`);
};

const db = createDatabase({ url: DB_URL });
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(DEPLOY_QUEUE_NAME, { connection: redis });

let cookie = "";

async function publishAsWorker(
  deploymentId: string,
  message: LogMessage
): Promise<number> {
  const seq = await redis.eval(
    LOG_PUBLISH_SCRIPT,
    2,
    logBufferKey(deploymentId),
    logSeqKey(deploymentId),
    encodeLogMessage(message),
    String(LOG_BUFFER_MAX_ENTRIES),
    String(LOG_BUFFER_TTL_SECONDS),
    logChannel(deploymentId)
  );
  return Number(seq);
}

async function drain(response: Response, ms: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  const pump = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  })().catch(() => {});
  await Promise.race([pump, sleep(ms)]);
  return text;
}

async function call(
  path: string,
  init: RequestInit = {}
): Promise<{ body: string; response: Response }> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  }
  return { body: await response.text(), response };
}

let server: ReturnType<typeof Bun.spawn> | undefined;

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/auth/ok`);
      if (r.ok) {
        return true;
      }
    } catch {}
    await sleep(500);
  }
  return false;
}

async function cleanup(): Promise<void> {
  await db.delete(session);
  await db.delete(account);
  await db.delete(user);
  await db.delete(deployments);
  await db.delete(services);
  await db.delete(environments);
  await db.delete(projects);
  await db.delete(servers);
  await queue.obliterate({ force: true }).catch(() => {});
}

try {
  await cleanup();

  server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, BETTER_AUTH_URL: BASE, PORT: String(PORT) },
    stderr: "pipe",
    stdout: "pipe",
  });

  if (await waitForServer()) {
    ok("the production server responds");
  } else {
    ko("the server did not start");
    throw new Error("aborting");
  }

  {
    const { response } = await call("/api/auth/get-session");
    if (response.status === 200) {
      ok("no session before signing in");
    } else {
      ko(`get-session without a cookie returned ${response.status}`);
    }
  }

  {
    const { response } = await call(
      "/api/logs/00000000-0000-0000-0000-000000000000"
    );
    if (response.status === 401) {
      ok("the log stream refuses an anonymous caller (401)");
    } else {
      ko(`the log stream returned ${response.status} instead of 401`);
    }
  }

  {
    const { response } = await call("/api/auth/sign-up/email", {
      body: JSON.stringify({ email: EMAIL, name: "admin", password: PASSWORD }),
      method: "POST",
    });
    if (response.ok) {
      ok("first administrator created");
    } else {
      ko(`creating the first account: ${response.status}`);
    }
  }

  {
    const saved = cookie;
    cookie = "";
    const { response } = await call("/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: "second@noddle.test",
        name: "second",
        password: PASSWORD,
      }),
      method: "POST",
    });
    cookie = saved;
    if (response.status >= 400) {
      ok(`second account refused (${response.status})`);
    } else {
      ko("a SECOND account was created: the lock doesn't hold");
    }
  }

  {
    cookie = "";
    const { response } = await call("/api/auth/sign-in/email", {
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      method: "POST",
    });
    if (response.ok && cookie.length > 0) {
      ok("signed in, session cookie set");
    } else {
      ko(`sign in: ${response.status}`);
    }
  }

  const [sshKey] = await db
    .insert(sshKeys)
    .values({ name: "verify-target", privateKeyEncrypted: "placeholder" })
    .onConflictDoUpdate({
      set: { privateKeyEncrypted: "placeholder" },
      target: sshKeys.name,
    })
    .returning();
  const [srv] = await db
    .insert(servers)
    .values({
      host: "203.0.113.7",
      name: "verify-target",
      sshKeyId: sshKey?.id ?? "",
      sshUser: "noddle",
    })
    .returning();
  const [proj] = await db
    .insert(projects)
    .values({ name: "verify" })
    .returning();
  const [envRow] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      environmentId: envRow?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: "https://example.invalid/app.git",
      name: "verify-app",
      port: 3000,
      serverId: srv?.id ?? "",
      sourceType: "git",
    })
    .returning();
  const serviceId = svc?.id ?? "";

  let deploymentId = "";

  const scopePath = `/projects/${proj?.id ?? ""}/${envRow?.id ?? ""}`;
  {
    const { body, response } = await call(scopePath);
    if (response.status === 200 && body.includes("verify-app")) {
      ok(
        "the environment renders the service (scope against the real database)"
      );
    } else {
      ko(`scope: status ${response.status}, service missing from the HTML`);
    }
    if (body.includes("verify-target")) {
      ok("the server/project/environment joins show up in the render");
    } else {
      ko("the joins don't show up in the render");
    }
  }

  {
    const saved = cookie;
    cookie = "";
    const { body, response } = await call(scopePath);
    if (response.status >= 300 || !body.includes("verify-app")) {
      ok(`anonymous dashboard refused (${response.status})`);
    } else {
      ko("the dashboard rendered the services to an anonymous caller");
    }
    cookie = saved;
  }

  {
    const [created] = await db
      .insert(deployments)
      .values({ serviceId, status: "queued", trigger: "manual" })
      .returning();
    deploymentId = created?.id ?? "";

    const job = await queue.add(
      "deploy",
      deployJobSchema.parse({ deploymentId, kind: "deploy" })
    );
    if (job.id) {
      ok("a deployment job really reaches Redis");
    } else {
      ko("the job was not accepted by the queue");
    }

    const parsed = deployJobSchema.safeParse(job.data);
    if (
      parsed.success &&
      parsed.data.kind === "deploy" &&
      parsed.data.deploymentId === deploymentId
    ) {
      ok("the job's shape matches the DeployJobData contract");
    } else {
      ko(
        `unexpected shape: ${JSON.stringify(job.data)} ${parsed.success ? "" : parsed.error.message}`
      );
    }
  }

  const [logRow] = await db
    .insert(deployments)
    .values({ serviceId, status: "queued", trigger: "manual" })
    .returning();
  const logDeploymentId = logRow?.id ?? "";

  {
    const key = logBufferKey(logDeploymentId);
    await redis.del(key, logSeqKey(logDeploymentId));
    const firstSeq = await publishAsWorker(logDeploymentId, {
      data: "line before arrival\n",
      type: "chunk",
    });

    const controller = new AbortController();
    const response = await fetch(`${BASE}/api/logs/${logDeploymentId}`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });

    if (
      response.ok &&
      response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      ok("the stream responds with text/event-stream");
    } else {
      ko(`unexpected content-type: ${response.headers.get("content-type")}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let received = "";

    const pump = (async () => {
      if (!reader) {
        return;
      }
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          return;
        }
        received += decoder.decode(chunk.value, { stream: true });
      }
    })().catch(() => {});

    await sleep(1500);
    if (received.includes("line before arrival")) {
      ok("catch-up: the viewer receives what went by before it arrived");
    } else {
      ko(`catch-up missing, received: ${received.slice(0, 120)}`);
    }

    await publishAsWorker(logDeploymentId, {
      data: "▸ live line\n",
      type: "chunk",
    });
    await sleep(1500);
    if (received.includes("live line")) {
      ok("live: a line published by the worker makes it through the stream");
    } else {
      ko("the published line did not arrive");
    }

    {
      const resumed = new AbortController();
      const replay = await drain(
        await fetch(`${BASE}/api/logs/${logDeploymentId}`, {
          headers: { Cookie: cookie, "Last-Event-ID": String(firstSeq) },
          signal: resumed.signal,
        }),
        1500
      );
      resumed.abort();

      if (
        replay.includes("live line") &&
        !replay.includes("line before arrival")
      ) {
        ok("resume: Last-Event-ID replays only what the viewer missed");
      } else {
        ko(`resume replayed the wrong slice: ${replay.slice(0, 160)}`);
      }
      if (replay.includes("event: reset")) {
        ko("resume told the viewer to drop a buffer it could have kept");
      } else {
        ok("resume keeps the viewer's buffer, no reset asked");
      }
    }

    await publishAsWorker(logDeploymentId, {
      status: "succeeded",
      type: "end",
    });
    await sleep(1500);
    if (received.includes("event: end")) {
      ok("the end message closes the stream");
    } else {
      ko("no end message received");
    }

    controller.abort();
    await pump;
  }

  {
    await db
      .update(deployments)
      .set({ status: "succeeded" })
      .where(eq(deployments.id, logDeploymentId));

    const response = await fetch(`${BASE}/api/logs/${logDeploymentId}`, {
      headers: { Cookie: cookie },
    });
    const text = await response.text();
    if (text.includes("event: end")) {
      ok("a finished deployment renders its archive then closes");
    } else {
      ko(`finished deployment: unexpected stream ${text.slice(0, 120)}`);
    }
    if (text.includes("event: reset")) {
      ok("a snapshot opens with a reset so a reconnect never duplicates");
    } else {
      ko("the snapshot did not announce a reset");
    }
  }

  {
    const key = logBufferKey(logDeploymentId);
    const ttl = await redis.ttl(key);
    if (ttl === -1) {
      ko("the log buffer has no TTL: it would stay in memory forever");
    } else {
      ok(
        `the log buffer expires (ttl ${ttl === -2 ? "already purged" : `${ttl}s`})`
      );
    }
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  server?.kill();
  await cleanup();
  await queue.close();
  await redis.quit();
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
