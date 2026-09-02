// tier: vm
// runtime: bun
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  decryptSecret,
  encryptSecret,
  loadAppKey,
  secretContext,
} from "@noddle/crypto";
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
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { Queue } from "bullmq";
import { eq, isNotNull } from "drizzle-orm";
import IORedis from "ioredis";

const DB_URL = devStack().databaseUrl;
const REDIS_URL = devStack().redisUrl;
const TARGET = devTarget();

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
  console.log(`  \u001B[32m✓\u001B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \u001B[31m✗\u001B[0m ${m}`);
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

function gitlabMr(
  action: string,
  number: number,
  sha: string,
  branch: string,
  sameProject = true
): string {
  return JSON.stringify({
    object_attributes: {
      action,
      iid: number,
      last_commit: { id: sha },
      source_branch: branch,
      source_project_id: sameProject ? 7 : 9,
      target_project_id: 7,
    },
    object_kind: "merge_request",
  });
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

type Forge = "github" | "gitlab";

function authHeaders(forge: Forge, body: string): Record<string, string> {
  return forge === "gitlab"
    ? { "x-gitlab-token": WEBHOOK_SECRET }
    : { "x-hub-signature-256": sign(body, WEBHOOK_SECRET) };
}

async function postWebhook(
  url: string,
  forge: Forge,
  body: string
): Promise<{ body: Record<string, unknown>; status: number }> {
  const r = await fetch(url, {
    body,
    headers: {
      "content-type": "application/json",
      ...authHeaders(forge, body),
    },
    method: "POST",
  });
  return {
    body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    status: r.status,
  };
}

async function waitForWeb(): Promise<boolean> {
  for (let i = 0; i < 120; i += 1) {
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
  await queue.obliterate({ force: true }).catch(() => {});
}

try {
  await cleanupDb();

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
    TARGET.keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    `${TARGET.user}@${TARGET.host}`,
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

  const revParse = Bun.spawnSync([
    "ssh",
    "-i",
    TARGET.keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    `${TARGET.user}@${TARGET.host}`,
    `git -C '${ORIGIN}' rev-parse HEAD`,
  ]);
  const headSha = revParse.stdout.toString().trim();

  const foundKey = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.name, "webhook-target"),
  });
  const sshKeyId = foundKey?.id ?? crypto.randomUUID();
  const keyValues = {
    id: sshKeyId,
    name: "webhook-target",
    privateKeyEncrypted: encryptSecret(
      TARGET.privateKey,
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
      host: TARGET.host,
      name: "webhook-target",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
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
      host: `${SERVICE_NAME}.${TARGET.host.replaceAll(".", "-")}.sslip.io`,
      serviceId: svc.id,
    });
  }

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

  const seededVars = [
    { isSecret: false, key: "PUBLIC_ONE", value: "visible-value" },
    { isSecret: true, key: "SECRET_TWO", value: "s3cr3t-value" },
  ];
  for (const v of seededVars) {
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
    }),
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

  for (const [label, headers] of [
    ["GitHub signature", { "x-hub-signature-256": "sha256=0000" }],
    ["GitLab token", { "x-gitlab-token": "not-the-secret" }],
  ] as const) {
    const body = githubPush("main", "0000000000000000000000000000000000000a");
    const res = await fetch(`${BASE}${path}`, {
      body,
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    });
    if (res.status === 401) {
      ok(`forged ${label} refused (401)`);
    } else {
      ko(`forged ${label}: status ${res.status} instead of 401`);
    }
  }

  {
    const before = await db.query.deployments.findMany({
      where: eq(deployments.serviceId, serviceId),
    });
    for (const forge of ["github", "gitlab"] as const) {
      const body = githubPush(
        "some-other-branch",
        "0000000000000000000000000000000000000b"
      );
      const res = await postWebhook(`${BASE}${path}`, forge, body);
      const after = await db.query.deployments.findMany({
        where: eq(deployments.serviceId, serviceId),
      });
      const skipped = Array.isArray(res.body.skipped)
        ? (res.body.skipped as string[])
        : [];
      if (
        res.status === 200 &&
        after.length === before.length &&
        skipped.length === 1
      ) {
        ok(`${forge}: different branch accepted, deployment ignored`);
      } else {
        ko(
          `${forge} different branch: status ${res.status}, ${after.length} deployment(s) instead of ${before.length}, skipped ${JSON.stringify(skipped)}`
        );
      }
    }
  }

  const body = githubPush("main", headSha);
  const res = await postWebhook(`${BASE}${path}`, "github", body);
  const queued = Array.isArray(res.body.queued)
    ? (res.body.queued as string[])
    : [];
  const [deploymentId] = queued;
  if (res.status === 200 && deploymentId) {
    ok(`webhook accepted, deployment ${deploymentId} queued`);
  } else {
    ko(`webhook: status ${res.status}, body ${JSON.stringify(res.body)}`);
    throw new Error("aborting");
  }

  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let final: typeof deployments.$inferSelect | undefined;
  while (Date.now() < deadline) {
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
  const postPr = (prPayload: string) =>
    postWebhook(`${BASE}${path}`, "github", prPayload);
  const previews = async () =>
    await db.query.services.findMany({
      where: isNotNull(services.previewOfServiceId),
      with: { domains: true },
    });

  for (const [forge, payload] of [
    ["github", githubPr("opened", 99, headSha, "feature/x", false)],
    ["gitlab", gitlabMr("open", 98, headSha, "feature/x", false)],
  ] as const) {
    const before = (await previews()).length;
    const r = await postWebhook(`${BASE}${path}`, forge, payload);
    const after = (await previews()).length;
    const reason = String(r.body.ignored ?? "");
    if (r.status === 200 && after === before && reason.includes("fork")) {
      ok(`${forge}: fork ignored (${reason}) — nothing created`);
    } else {
      ko(
        `${forge} fork: status ${r.status}, reason "${reason}", ${after} preview(s) instead of ${before}`
      );
    }
  }

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

  {
    const copied = await db.query.envVars.findMany({
      where: eq(envVars.serviceId, created.id),
    });
    if (copied.length === seededVars.length) {
      ok(`the ${copied.length} parent variables were copied`);
    } else {
      ko(`${copied.length} variable(s) copied out of ${seededVars.length}`);
    }

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

  {
    const r = await postPr(githubPr("closed", 7, headSha, "feature/x"));
    const outcomes = Array.isArray(r.body.outcomes)
      ? (r.body.outcomes as { destroyed?: string }[])
      : [];
    if (r.status === 200 && outcomes.some((o) => o.destroyed)) {
      ok("PR closed → teardown queued");
    } else {
      ko(`closed: status ${r.status}, body ${JSON.stringify(r.body)}`);
    }

    const gone = Date.now() + 120_000;
    let left = 1;
    while (Date.now() < gone) {
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
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const p of procs) {
    p.kill();
  }
  await queue.close();
  await redis.quit();
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
