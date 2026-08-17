// tier: local
import {
  deployments,
  environments,
  envVars,
  projects,
  servers,
  serviceDomains,
  services,
  sshKeys,
} from "@noddle/db/schema";
import { eq, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { ensurePreview, PREVIEW_LIMIT } from "@/lib/preview.server";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1B[32m✓\x1B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1B[31m✗\x1B[0m ${m}`);
};

const SHA = "0".repeat(40);

const livePreviews = async () =>
  await db.query.services.findMany({
    where: isNotNull(services.previewOfServiceId),
  });

/** Clean setup: these tables are shared by every test harness. */
await db.delete(deployments);
await db.delete(envVars);
await db.delete(services);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers);

try {
  const [sshKey] = await db
    .insert(sshKeys)
    .values({ name: "preview-limit-probe", privateKeyEncrypted: "placeholder" })
    .onConflictDoUpdate({
      set: { privateKeyEncrypted: "placeholder" },
      target: sshKeys.name,
    })
    .returning();
  const [server] = await db
    .insert(servers)
    .values({
      host: "192.0.2.10",
      name: "preview-limit-probe",
      role: "manager",
      sshKeyId: sshKey?.id ?? "",
      sshUser: "ubuntu",
      status: "connected",
    })
    .returning();
  const [project] = await db.insert(projects).values({ name: "limit-proj" }).returning();
  const [environment] = await db
    .insert(environments)
    .values({ name: "production", projectId: project?.id ?? "" })
    .returning();
  const [parent] = await db
    .insert(services)
    .values({
      environmentId: environment?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: "https://example.invalid/app.git",
      name: "app",
      port: 3000,
      serverId: server?.id ?? "",
      sourceType: "git",
    })
    .returning();
  if (!parent) {
    throw new Error("failed to insert the parent service");
  }
  await db.insert(serviceDomains).values({
    host: "app.192-0-2-10.sslip.io",
    serviceId: parent.id,
  });

  // ── filling up to the cap ─────────────────────────────────────────────────
  const madeIds: string[] = [];
  for (let pr = 1; pr <= PREVIEW_LIMIT; pr += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered writes, deliberate
    const r = await ensurePreview({
      commitSha: SHA,
      headBranch: `feature/${pr}`,
      parentServiceId: parent.id,
      prNumber: pr,
    });
    if ("ignored" in r) {
      ko(`PR ${pr} refused even though the cap has not been reached: ${r.ignored}`);
      throw new Error("aborting");
    }
    madeIds.push(r.serviceId);
  }
  const atLimit = await livePreviews();
  if (atLimit.length === PREVIEW_LIMIT) {
    ok(`${PREVIEW_LIMIT} previews created, the cap is reached`);
  } else {
    ko(`${atLimit.length} preview(s) instead of ${PREVIEW_LIMIT}`);
    throw new Error("aborting");
  }

  // ── the sixth one ──────────────────────────────────────────────────────────
  {
    const before = (await livePreviews()).length;
    const r = await ensurePreview({
      commitSha: SHA,
      headBranch: "feature/6",
      parentServiceId: parent.id,
      prNumber: 6,
    });
    const after = (await livePreviews()).length;
    const reason = "ignored" in r ? r.ignored : "";
    // The REASON, not just "ignored": three other paths also return an
    // `{ignored}`, and a test that accepts any of them proves nothing.
    if (reason.includes("limit reached") && after === before) {
      ok(`the 6th is refused by the CAP ("${reason}") — nothing created`);
    } else {
      ko(`6th: reason "${reason || "created!"}", ${after} preview(s) instead of ${before}`);
    }
  }

  // ── at the cap, a new push on a PR ALREADY previewed ─────────────────────
  //
  // The case that would break silently: the `existing` branch exits BEFORE
  // the cap check. If the order were ever reversed, pushing to an existing
  // PR would stop redeploying it as soon as the installation is full — a
  // preview frozen on an old commit, with not a single message about it.
  {
    const [, , targetId] = madeIds;
    const before = (await livePreviews()).length;
    const r = await ensurePreview({
      commitSha: "1".repeat(40),
      headBranch: "feature/3",
      parentServiceId: parent.id,
      prNumber: 3,
    });
    const after = (await livePreviews()).length;
    if (!("ignored" in r) && r.created === false && r.serviceId === targetId && after === before) {
      ok("at the cap, a PR already previewed still redeploys");
    } else {
      ko(`PR 3 at the cap: ${JSON.stringify(r)}, ${after} preview(s) instead of ${before}`);
    }
  }

  // ── a preview being torn down frees up its slot ───────────────────────────
  //
  // This is what `PREVIEW_LIMIT`'s comment PROMISES. Unverified, that
  // promise would rest on a `ne(status, 'deleting')` that nothing protects.
  {
    await db
      .update(services)
      .set({ status: "deleting" })
      .where(eq(services.id, madeIds[0] ?? ""));

    const r = await ensurePreview({
      commitSha: SHA,
      headBranch: "feature/6",
      parentServiceId: parent.id,
      prNumber: 6,
    });
    if ("ignored" in r) {
      ko(`freeing one slot wasn't enough: ${r.ignored}`);
    } else {
      ok("a preview being torn down frees its slot — the 6th goes through");
    }

    // And the count does pick back up at the 7th: the cap wasn't "consumed".
    const r7 = await ensurePreview({
      commitSha: SHA,
      headBranch: "feature/7",
      parentServiceId: parent.id,
      prNumber: 7,
    });
    const reason7 = "ignored" in r7 ? r7.ignored : "";
    if (reason7.includes("limit reached")) {
      ok("the next one is refused again — the cap still holds");
    } else {
      ko(`7th: expected a cap refusal, got ${JSON.stringify(r7)}`);
    }
  }

  // ── is the cap really INSTALLATION-WIDE? ──────────────────────────────────
  //
  // `isNotNull(previewOfServiceId)` filters neither by parent nor by
  // project. A second project must therefore NOT start back from zero.
  {
    const [proj2] = await db.insert(projects).values({ name: "limit-proj-2" }).returning();
    const [env2] = await db
      .insert(environments)
      .values({ name: "production", projectId: proj2?.id ?? "" })
      .returning();
    const [parent2] = await db
      .insert(services)
      .values({
        environmentId: env2?.id ?? "",
        gitBranch: "main",
        gitRepoUrl: "https://example.invalid/other.git",
        name: "other",
        port: 3000,
        serverId: server?.id ?? "",
        sourceType: "git",
      })
      .returning();
    if (parent2) {
      await db.insert(serviceDomains).values({
        host: "other.192-0-2-10.sslip.io",
        serviceId: parent2.id,
      });
    }
    const r = await ensurePreview({
      commitSha: SHA,
      headBranch: "feature/x",
      parentServiceId: parent2?.id ?? "",
      prNumber: 1,
    });
    const reason = "ignored" in r ? r.ignored : "";
    if (reason.includes("limit reached")) {
      ok("an OTHER project doesn't start back from zero — the cap is global");
    } else {
      ko(`other project: expected a cap refusal, got ${JSON.stringify(r)}`);
    }
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await db.delete(deployments);
  await db.delete(envVars);
  await db.delete(services);
  await db.delete(environments);
  await db.delete(projects);
  await db.delete(servers);
}

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);
