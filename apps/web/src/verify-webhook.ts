// Prerequisites: the Multipass VM, Postgres, Redis, migrations applied.
//
//   bun run src/verify-webhook.ts
//
// Expect a few minutes: the build is real.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDatabase } from "@noddle/db";
import {
  account,
  deploymentLogs,
  deployments,
  environments,
  envVars,
  projects,
  servers,
  serviceDomains,
  services,
  session,
  sshKeys,
  user,
} from "@noddle/db/schema";
import { DEPLOY_QUEUE_NAME } from "@noddle/deploy-contract";
import {
  decryptSecret,
  encryptSecret,
  loadAppKey,
  secretContext,
} from "@noddle/shared/crypto";
import { Queue } from "bullmq";
import { eq, isNotNull } from "drizzle-orm";
import IORedis from "ioredis";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const PORT = Number(process.env.PORT ?? 3313);
const BASE = `http://localhost:${PORT}`;
const SERVICE_NAME = "noddle-webhook";
const ORIGIN = "/opt/noddle-webhook-origin";
const WEBHOOK_SECRET = "webhook-secret-for-testing-1234567890";

const DEPLOY_TIMEOUT_MS = 8 * 60 * 1000;

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

const appKey = loadAppKey(process.env.APP_KEY);
const db = createDatabase({ url: DB_URL });
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(DEPLOY_QUEUE_NAME, { connection: redis });

const procs: ReturnType<typeof Bun.spawn>[] = [];
const repoRoot = new URL("../../..", import.meta.url).pathname;

function githubPush(ref: string, sha: string): string {
  return JSON.stringify({ after: sha, ref: `refs/heads/${ref}` });
}

/**
 * A GitHub pull request payload, trimmed down to what the reader looks at.
 * `sameRepo=false` simulates a fork: different source and target repos.
 */
function githubPr(
  action: string,
  number: number,
  sha: string,
  branch: string,
  sameRepo = true
): string {
  return JSON.stringify({
    action,
    number,
    pull_request: {
      base: { repo: { full_name: "me/app" } },
      head: {
        ref: branch,
        repo: { full_name: sameRepo ? "me/app" : "someone/app" },
        sha,
      },
      number,
    },
  });
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function waitForWeb(): Promise<boolean> {
  for (let i = 0; i < 120; i += 1) {
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

async function cleanupDb(): Promise<void> {
  await db.delete(session);
  await db.delete(account);
  await db.delete(user);
  await db.delete(deploymentLogs);
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
  await cleanupDb();

  // ── setup: source repository on the target, like verify-live.ts ──────────
  const remoteScript = [
    `sudo rm -rf '${ORIGIN}'`,
    `sudo mkdir -p '${ORIGIN}'`,
    `sudo chown -R "$USER" '${ORIGIN}'`,
    `cd '${ORIGIN}'`,
    `printf '%s' '{"name":"webhook","scripts":{"start":"node s.js"}}' > package.json`,
    `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("webhook hello")).listen(p)' > s.js`,
    "git init -q -b main .",
    "git config user.email e@x",
    "git config user.name e",
    "git add -A",
    "git commit -q -m init",
  ].join(" && ");

  const seed = Bun.spawnSync([
    "ssh",
    "-i",
    KEY,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    `${USER}@${HOST}`,
    remoteScript,
  ]);
  if (seed.exitCode === 0) {
    ok("source repository created on the VM");
  } else {
    ko(
      `creating the source repository: ${seed.stderr.toString().slice(0, 200)}`
    );
    throw new Error("aborting");
  }

  // The real SHA of HEAD: a real webhook sends the commit it just pushed,
  // never a made-up value — `after` has to point at something `git
  // checkout` can actually find.
  const revParse = Bun.spawnSync([
    "ssh",
    "-i",
    KEY,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    `${USER}@${HOST}`,
    `git -C '${ORIGIN}' rev-parse HEAD`,
  ]);
  const headSha = revParse.stdout.toString().trim();

  // ── setup: database rows ───────────────────────────────────────────────────
  const foundKey = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.name, "webhook-target"),
  });
  const sshKeyId = foundKey?.id ?? crypto.randomUUID();
  const keyValues = {
    id: sshKeyId,
    name: "webhook-target",
    privateKeyEncrypted: encryptSecret(
      readFileSync(KEY, "utf8"),
      appKey,
      secretContext.sshKey(sshKeyId)
    ),
  };
  if (foundKey) {
    await db.update(sshKeys).set(keyValues).where(eq(sshKeys.id, sshKeyId));
  } else {
    await db.insert(sshKeys).values(keyValues);
  }
  const [srv] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "webhook-target",
      role: "manager",
      sshKeyId,
      sshUser: USER,
      totalMemoryMb: 2048,
    })
    .returning();

  const [proj] = await db
    .insert(projects)
    .values({ name: "webhook" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: `file://${ORIGIN}`,
      name: SERVICE_NAME,
      port: 3000,
      serverId: srv?.id ?? "",
      sourceType: "git",
    })
    .returning();
  const serviceId = svc?.id ?? "";
  if (svc) {
    await db.insert(serviceDomains).values({
      host: `${SERVICE_NAME}.${HOST.replaceAll(".", "-")}.sslip.io`,
      serviceId: svc.id,
    });
  }

  // The secret is set DIRECTLY here, encrypted with the same primitives as
  // `generateServiceWebhook` — this test targets the RECEIVER (signature,
  // branch filtering, job queuing), not the generation form.
  await db
    .update(services)
    .set({
      webhookSecretEncrypted: encryptSecret(
        WEBHOOK_SECRET,
        appKey,
        secretContext.webhookSecret(serviceId)
      ),
    })
    .where(eq(services.id, serviceId));
  ok("server, service and webhook secret registered");

  // Two variables on the parent, one of them a SECRET. Without them, the
  // copy assertion below would compare zero to zero and prove nothing —
  // which is exactly what it did on its first pass. And the copy decrypts
  // then RE-ENCRYPTS under a different AAD (bound to the row): broken, the
  // preview would die at deploy time on an unreadable secret.
  const seededVars = [
    { isSecret: false, key: "PUBLIC_ONE", value: "visible-value" },
    { isSecret: true, key: "SECRET_TWO", value: "s3cr3t-value" },
  ];
  for (const v of seededVars) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential setup, deliberate
    const [row] = await db
      .insert(envVars)
      .values({
        isSecret: v.isSecret,
        key: v.key,
        serviceId,
        valueEncrypted: "placeholder",
      })
      .returning();
    await db
      .update(envVars)
      .set({
        valueEncrypted: encryptSecret(
          v.value,
          appKey,
          secretContext.envVar(row?.id ?? "")
        ),
      })
      .where(eq(envVars.id, row?.id ?? ""));
  }

  // ── BUILD before serving ───────────────────────────────────────────────────
  //
  // `server.ts` serves `dist/server/server.js`, not the source. Without
  // this step, the harness starts the bundle from the LAST build and so
  // tests code that no longer matches the repository — quietly, since an
  // old bundle works just fine. Paid for once already: the pull request
  // scenarios hit "unrecognized payload" because the PR reader didn't
  // exist in the served bundle.
  const built = Bun.spawnSync(["bunx", "vite", "build"], {
    cwd: join(repoRoot, "apps/web"),
    env: process.env,
  });
  if (built.exitCode === 0) {
    ok("apps/web built — the served bundle matches the repository");
  } else {
    ko(`vite build failed: ${built.stderr.toString().slice(-400)}`);
    throw new Error("aborting");
  }

  // ── the two processes, for real ─────────────────────────────────────────
  //
  // `LOG_ROOT` is set EXPLICITLY. Otherwise the worker falls back to
  // `/var/lib/noddle/logs`, which is the PRODUCTION path — inside the
  // container, where it's mounted. Here the worker runs on the development
  // machine, where `mkdir /var/lib/noddle` fails with EACCES: the
  // deployment job used to die before even opening its SSH connection, and
  // the harness waited eight minutes for a build that had never started.
  // The script depended on an ambient environment variable it never set.
  const workerEnv = {
    ...process.env,
    LOG_ROOT: join(tmpdir(), "noddle-verify-webhook-logs"),
  };

  procs.push(
    Bun.spawn(["node", "src/index.ts"], {
      cwd: join(repoRoot, "apps/worker"),
      env: workerEnv,
      stderr: "pipe",
      stdout: "pipe",
    })
  );
  procs.push(
    Bun.spawn(["bun", "run", "server.ts"], {
      cwd: join(repoRoot, "apps/web"),
      env: { ...workerEnv, PORT: String(PORT) },
      stderr: "pipe",
      stdout: "pipe",
    })
  );

  if (await waitForWeb()) {
    ok("worker and web started");
  } else {
    ko("the web app did not start");
    throw new Error("aborting");
  }

  const path = `/api/webhooks/service/${serviceId}`;

  // ── forged signature: refused, NOTHING happens ────────────────────────────
  {
    const body = githubPush("main", "0000000000000000000000000000000000000a");
    const res = await fetch(`${BASE}${path}`, {
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=0000",
      },
      method: "POST",
    });
    if (res.status === 401) {
      ok("invalid signature refused (401)");
    } else {
      ko(`invalid signature: status ${res.status} instead of 401`);
    }
  }

  // ── different branch: accepted but ignored, no deployment ────────────────
  {
    const before = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, serviceId),
    });
    const body = githubPush(
      "some-other-branch",
      "0000000000000000000000000000000000000b"
    );
    const res = await fetch(`${BASE}${path}`, {
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
      },
      method: "POST",
    });
    const after = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, serviceId),
    });
    if (res.ok && after.length === before.length) {
      ok("different branch: signature accepted, deployment ignored");
    } else {
      ko(
        `different branch: status ${res.status}, ${after.length} deployment(s) instead of ${before.length}`
      );
    }
  }

  // ── THE test: a signed push on the right branch really deploys ──────────
  const body = githubPush("main", headSha);
  const res = await fetch(`${BASE}${path}`, {
    body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
    },
    method: "POST",
  });
  const payload = (await res.json()) as { deploymentId?: string };
  if (res.ok && payload.deploymentId) {
    ok(`webhook accepted, deployment ${payload.deploymentId} queued`);
  } else {
    ko(`webhook: status ${res.status}, body ${JSON.stringify(payload)}`);
    throw new Error("aborting");
  }

  const { deploymentId } = payload;
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let final: typeof deployments.$inferSelect | undefined;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: waiting for the real build
    const row = await db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
    });
    if (row?.finishedAt) {
      final = row;
      break;
    }
    await sleep(3000);
  }

  if (final?.trigger === "webhook" && final.status === "succeeded") {
    ok(`webhook-triggered deployment converged — image ${final.imageTag}`);
  } else {
    ko(
      `final status ${final?.status ?? "never finished"}, trigger ${final?.trigger ?? "—"}`
    );
  }
  // ── pull request previews ────────────────────────────────────────────────
  //
  // The SAME webhook, the other event. What matters here isn't that a PR
  // deploys — it's that a fork gets NOTHING, and that a `synchronize`
  // lands on the same row instead of creating a second one.
  const postPr = async (prPayload: string) => {
    const r = await fetch(`${BASE}${path}`, {
      body: prPayload,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(prPayload, WEBHOOK_SECRET),
      },
      method: "POST",
    });
    return {
      body: (await r.json()) as Record<string, unknown>,
      status: r.status,
    };
  };
  const previews = async () =>
    await db.query.services.findMany({
      where: isNotNull(services.previewOfServiceId),
      with: { domains: true },
    });

  // A FORK: no preview at all, and above all no secrets leaking out.
  {
    const before = (await previews()).length;
    const r = await postPr(githubPr("opened", 99, headSha, "feature/x", false));
    const after = (await previews()).length;
    // The REASON, not just "ignored": the push reader also answers
    // `{ignored: …}` on a payload it doesn't recognize. This test's first
    // version went through that path, so it never actually exercised fork
    // detection — a green that proved nothing.
    const reason = String(r.body.ignored ?? "");
    if (r.status === 200 && after === before && reason.includes("fork")) {
      ok(`fork PR ignored (${reason}) — nothing created`);
    } else {
      ko(
        `fork: status ${r.status}, reason "${reason}", ${after} preview(s) instead of ${before}`
      );
    }
  }

  // A PR opened from the SAME repo: a preview is born.
  const opened = await postPr(githubPr("opened", 7, headSha, "feature/x"));
  const created = (await previews()).find((p) => p.prNumber === 7);
  if (opened.status === 200 && created) {
    ok(
      `PR 7 → preview ${created.name}, domain ${created.domains[0]?.host ?? "none"}`
    );
  } else {
    ko(`PR 7: status ${opened.status}, body ${JSON.stringify(opened.body)}`);
    throw new Error("aborting");
  }

  // Did the parent's variables FOLLOW, secrets included — and above all, do
  // the values DECRYPT under the new AAD?
  {
    const copied = await db.query.envVars.findMany({
      where: eq(envVars.serviceId, created.id),
    });
    if (copied.length === seededVars.length) {
      ok(`the ${copied.length} parent variables were copied`);
    } else {
      ko(`${copied.length} variable(s) copied out of ${seededVars.length}`);
    }

    // THE test: a copy that doesn't decrypt is worse than a missing copy
    // — the defect would only show up when the container starts.
    const wrong: string[] = [];
    for (const row of copied) {
      const expected = seededVars.find((v) => v.key === row.key);
      try {
        const value = decryptSecret(
          row.valueEncrypted,
          appKey,
          secretContext.envVar(row.id)
        );
        if (value !== expected?.value) {
          wrong.push(`${row.key} (different value)`);
        }
      } catch {
        wrong.push(`${row.key} (unreadable)`);
      }
    }
    if (wrong.length === 0 && copied.length > 0) {
      ok("every value decrypts under ITS new row's AAD");
    } else {
      ko(`unreadable or wrong values: ${wrong.join(", ") || "no copy at all"}`);
    }

    const secretCopied = copied.find((r) => r.key === "SECRET_TWO");
    if (secretCopied?.isSecret === true) {
      ok("the `isSecret` flag followed the copy");
    } else {
      ko("the `isSecret` flag did not follow");
    }
  }

  // `synchronize`: the SAME row redeploys, never a second one.
  {
    const before = await previews();
    const r = await postPr(githubPr("synchronize", 7, headSha, "feature/x"));
    const after = await previews();
    if (r.status === 200 && after.length === before.length) {
      ok("synchronize → same preview redeployed, not a second one");
    } else {
      ko(`synchronize: ${after.length} preview(s) instead of ${before.length}`);
    }
  }

  // An action that changes nothing must trigger NOTHING.
  {
    const before = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, created.id),
    });
    await postPr(githubPr("labeled", 7, headSha, "feature/x"));
    const after = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, created.id),
    });
    if (after.length === before.length) {
      ok("`labeled` action → no additional deployment");
    } else {
      ko(`labeled triggered ${after.length - before.length} deployment(s)`);
    }
  }

  // `closed`: the preview is torn down.
  {
    const r = await postPr(githubPr("closed", 7, headSha, "feature/x"));
    if (r.status === 200 && r.body.destroyed) {
      ok("PR closed → teardown queued");
    } else {
      ko(`closed: status ${r.status}, body ${JSON.stringify(r.body)}`);
    }

    const gone = Date.now() + 120_000;
    let left = 1;
    while (Date.now() < gone) {
      // biome-ignore lint/performance/noAwaitInLoops: waiting for the real teardown
      left = (await previews()).filter((p) => p.prNumber === 7).length;
      if (left === 0) {
        break;
      }
      await sleep(3000);
    }
    if (left === 0) {
      ok("the preview disappeared from the database");
    } else {
      ko("the preview is still there after 120s");
    }
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const p of procs) {
    p.kill();
  }
  await queue.close();
  await redis.quit();
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
