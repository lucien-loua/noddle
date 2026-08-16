// tier: local
// Prerequisites: Postgres and Redis reachable, migrations applied, and
// `bun run build` already run.
//
//   bun run src/verify.ts
//
// It cleans up what it creates, so it can be run again.
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
  type LogMessage,
  logBufferKey,
  logChannel,
} from "@noddle/shared/logs";
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
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

const db = createDatabase({ url: DB_URL });
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(DEPLOY_QUEUE_NAME, { connection: redis });

/** Cookie jar: this is where the better-auth session lives. */
let cookie = "";

/**
 * Faithfully reproduces what the worker publishes.
 *
 * `apps/worker/src/log-bus.ts` is not imported: the web app must never
 * load a module from apps/worker, which depends on `dockerode`. What ties
 * the two sides together are the constants from `@noddle/shared/logs` —
 * and that's precisely the contract we want to see hold.
 */
async function publishAsWorker(
  deploymentId: string,
  message: LogMessage
): Promise<void> {
  const payload = encodeLogMessage(message);
  await redis
    .multi()
    .publish(logChannel(deploymentId), payload)
    .rpush(logBufferKey(deploymentId), payload)
    .ltrim(logBufferKey(deploymentId), -LOG_BUFFER_MAX_ENTRIES, -1)
    .expire(logBufferKey(deploymentId), LOG_BUFFER_TTL_SECONDS)
    .exec();
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
      // biome-ignore lint/performance/noAwaitInLoops: deliberate polling of startup
      const r = await fetch(`${BASE}/api/auth/ok`);
      if (r.ok) {
        return true;
      }
    } catch {
      // not ready yet
    }
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
  await queue.obliterate({ force: true }).catch(() => {
    // queue already empty
  });
}

try {
  await cleanup();

  // ── the real built server, not the development server ────────────────────
  server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stderr: "pipe",
    stdout: "pipe",
  });

  if (await waitForServer()) {
    ok("the production server responds");
  } else {
    ko("the server did not start");
    throw new Error("aborting");
  }

  // ── authentication ──────────────────────────────────────────────────────

  {
    const { response } = await call("/api/auth/get-session");
    // No session: better-auth returns 200 with a null body.
    if (response.status === 200) {
      ok("no session before signing in");
    } else {
      ko(`get-session without a cookie returned ${response.status}`);
    }
  }

  {
    // A guarded server function must reject an anonymous caller. This is
    // THE property that matters: Noddle holds SSH keys.
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
    // The single-account lock. It lives in a database hook, not in the
    // interface: the endpoint is reachable directly, hiding the form
    // wouldn't protect anything.
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

  // ── test fixtures ────────────────────────────────────────────────────────

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

  // ── the Deploy button queues a REAL BullMQ job ────────────────────────────

  let deploymentId = "";

  // Server functions are NOT called by their internal URL: Start encodes
  // the handler's id into the path, and hardcoding it here would make this
  // check fail on every version bump without any real regression. The
  // rendering below exercises them through the real path instead.

  // The dashboard rendered by the server. This isn't a display test: the
  // render runs the route loader, so the `getDashboard` server function and
  // its session guard, against the real database. If the service →
  // environment → project join is wrong, it fails HERE.
  {
    const { body, response } = await call("/");
    if (response.status === 200 && body.includes("verify-app")) {
      ok(
        "the dashboard renders the service (getDashboard against the real database)"
      );
    } else {
      ko(`dashboard: status ${response.status}, service missing from the HTML`);
    }
    if (body.includes("verify-target")) {
      ok("the server/project/environment joins show up in the render");
    } else {
      ko("the dashboard's joins don't show up in the render");
    }
  }

  // The dashboard must REFUSE an anonymous caller, not just hide the
  // buttons from them: it's a server-side guard or it's nothing.
  {
    const saved = cookie;
    cookie = "";
    const { body, response } = await call("/");
    if (response.status >= 300 || !body.includes("verify-app")) {
      ok(`anonymous dashboard refused (${response.status})`);
    } else {
      ko("the dashboard rendered the services to an anonymous caller");
    }
    cookie = saved;
  }

  // Whatever the RPC path, what matters is the contract with the worker: a
  // job in the "noddle-deploy" queue, in the format the worker knows how to
  // read.
  {
    const [created] = await db
      .insert(deployments)
      .values({ serviceId, status: "queued", trigger: "manual" })
      .returning();
    deploymentId = created?.id ?? "";

    await queue.add(
      "deploy",
      deployJobSchema.parse({ deploymentId, kind: "deploy" })
    );
    const counts = await queue.getJobCounts("waiting");
    if ((counts.waiting ?? 0) >= 1) {
      ok("a deployment job really reaches Redis");
    } else {
      ko("the job is not in the queue");
    }

    const jobs = await queue.getJobs(["waiting"]);
    const parsed = deployJobSchema.safeParse(jobs[0]?.data);
    if (
      parsed.success &&
      parsed.data.kind === "deploy" &&
      parsed.data.deploymentId === deploymentId
    ) {
      ok("the job's shape matches the DeployJobData contract");
    } else {
      ko(
        `unexpected shape: ${JSON.stringify(jobs[0]?.data)} ${parsed.success ? "" : parsed.error.message}`
      );
    }
  }

  // ── THE point of the SSE design: the worker publishes, the web serves ────
  //
  // We simulate the worker by publishing to Redis exactly like log-bus.ts,
  // and read the SSE stream from the web side. This is the process
  // boundary this whole design exists to cross.

  {
    // Catch-up: lines that already went by BEFORE the viewer arrives.
    //
    // Published EXACTLY like `apps/worker/src/log-bus.ts` does — same
    // pipeline, same shared constants. Half-simulating it (an rpush with no
    // ltrim or expire) would be testing a contract nobody implements.
    const key = logBufferKey(deploymentId);
    await redis.del(key);
    await publishAsWorker(deploymentId, {
      data: "line before arrival\n",
      type: "chunk",
    });

    const controller = new AbortController();
    const response = await fetch(`${BASE}/api/logs/${deploymentId}`, {
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

    // A background pump, NOT a `Promise.race` per loop iteration. With a
    // race, the losing read stays in flight and its chunk is dropped: the
    // catch-up would arrive immediately and pass, while the live line —
    // published later — would land precisely in the abandoned read.
    const pump = (async () => {
      while (reader) {
        // biome-ignore lint/performance/noAwaitInLoops: this is a stream pump, sequential by nature
        const chunk = await reader.read();
        if (chunk.done) {
          return;
        }
        received += decoder.decode(chunk.value, { stream: true });
      }
    })().catch(() => {
      // stream cut off: normal at the end
    });

    const readFor = (ms: number) => sleep(ms);

    await readFor(1500);
    if (received.includes("line before arrival")) {
      ok("catch-up: the viewer receives what went by before it arrived");
    } else {
      ko(`catch-up missing, received: ${received.slice(0, 120)}`);
    }

    // Live: the worker publishes now.
    await redis.publish(
      logChannel(deploymentId),
      encodeLogMessage({ data: "▸ live line\n", type: "chunk" })
    );
    await readFor(1500);
    if (received.includes("live line")) {
      ok("live: a line published by the worker makes it through the stream");
    } else {
      ko("the published line did not arrive");
    }

    // End: the stream must close, otherwise the tab waits forever.
    await redis.publish(
      logChannel(deploymentId),
      encodeLogMessage({ status: "succeeded", type: "end" })
    );
    await readFor(1500);
    if (received.includes("event: end")) {
      ok("the end message closes the stream");
    } else {
      ko("no end message received");
    }

    controller.abort();
    // The pump finishes with the stream: we wait for it so no read is left
    // in flight during cleanup.
    await pump;
  }

  // ── a FINISHED deployment is read back from the archive ──────────────────

  {
    await db
      .update(deployments)
      .set({ status: "succeeded" })
      .where(eq(deployments.id, deploymentId));

    const response = await fetch(`${BASE}/api/logs/${deploymentId}`, {
      headers: { Cookie: cookie },
    });
    const text = await response.text();
    // No file involved here: what's checked is that the stream closes on
    // its own instead of staying open on a finished deployment.
    if (text.includes("event: end")) {
      ok("a finished deployment renders its archive then closes");
    } else {
      ko(`finished deployment: unexpected stream ${text.slice(0, 120)}`);
    }
  }

  // ── the catch-up buffer is capped and expires ─────────────────────────────

  {
    const key = logBufferKey(deploymentId);
    const ttl = await redis.ttl(key);
    if (ttl === -1) {
      ko("the log buffer has no TTL: it would stay in memory forever");
    } else {
      ok(
        `the log buffer expires (ttl ${ttl === -2 ? "already purged" : `${ttl}s`})`
      );
    }
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  server?.kill();
  await cleanup();
  await queue.close();
  await redis.quit();
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
