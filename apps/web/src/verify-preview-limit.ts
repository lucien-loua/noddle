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
import { assertDevStack } from "@noddle/testing/dev-stack";
import { eq, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { ensurePreview, PREVIEW_LIMIT } from "@/lib/preview.server";

assertDevStack();

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

const SHA = "0".repeat(40);

const livePreviews = async () =>
  await db.query.services.findMany({
    where: isNotNull(services.previewOfServiceId),
  });

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
  const [project] = await db
    .insert(projects)
    .values({ name: "limit-proj" })
    .returning();
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

  const madeIds: string[] = [];
  for (let pr = 1; pr <= PREVIEW_LIMIT; pr += 1) {
    const r = await ensurePreview({
      commitSha: SHA,
      headBranch: `feature/${pr}`,
      parentServiceId: parent.id,
      prNumber: pr,
    });
    if ("ignored" in r) {
      ko(
        `PR ${pr} refused even though the cap has not been reached: ${r.ignored}`
      );
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
    if (reason.includes("limit reached") && after === before) {
      ok(`the 6th is refused by the CAP ("${reason}") — nothing created`);
    } else {
      ko(
        `6th: reason "${reason || "created!"}", ${after} preview(s) instead of ${before}`
      );
    }
  }

  {
    const targetId = madeIds.at(2);
    const before = (await livePreviews()).length;
    const r = await ensurePreview({
      commitSha: "1".repeat(40),
      headBranch: "feature/3",
      parentServiceId: parent.id,
      prNumber: 3,
    });
    const after = (await livePreviews()).length;
    if (
      !("ignored" in r) &&
      r.created === false &&
      r.serviceId === targetId &&
      after === before
    ) {
      ok("at the cap, a PR already previewed still redeploys");
    } else {
      ko(
        `PR 3 at the cap: ${JSON.stringify(r)}, ${after} preview(s) instead of ${before}`
      );
    }
  }

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

  {
    const [proj2] = await db
      .insert(projects)
      .values({ name: "limit-proj-2" })
      .returning();
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
