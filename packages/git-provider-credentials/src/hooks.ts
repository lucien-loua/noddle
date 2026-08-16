import type { Database } from "@noddle/db";
import { gitlabRepositoryHooks } from "@noddle/db/schema";
import {
  createProjectHook,
  deleteProjectHook,
  listProjectHooks,
} from "@noddle/git-provider/gitlab";
import { and, eq } from "drizzle-orm";
import { gitlabAccessToken, gitlabWebhookSecret } from "./index.ts";

/**
 * Repository hooks — the per-project webhooks Noddle registers on GitLab.
 * One reconcile used two ways: web for a single repository on save, the
 * worker's sweep for all of them.
 */

export interface HookOutcome {
  error: string | null;
  repositoryFullName: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function record(
  db: Database,
  gitProviderId: string,
  repositoryFullName: string,
  hookUrl: string,
  values: { hookId: string | null; lastError: string | null }
): Promise<void> {
  await db
    .insert(gitlabRepositoryHooks)
    .values({ gitProviderId, hookUrl, repositoryFullName, ...values })
    .onConflictDoUpdate({
      set: { ...values, hookUrl, updatedAt: new Date() },
      target: [
        gitlabRepositoryHooks.gitProviderId,
        gitlabRepositoryHooks.repositoryFullName,
      ],
    });
}

/**
 * Never throws for a GitLab refusal: the token's user may not be Maintainer,
 * and that must not fail the Service save.
 */
export async function ensureRepositoryHook(
  db: Database,
  appKey: Buffer,
  target: {
    gitProviderId: string;
    hookUrl: string;
    repositoryFullName: string;
  }
): Promise<HookOutcome> {
  const { gitProviderId, hookUrl, repositoryFullName } = target;
  try {
    const [{ token, url }, secret] = await Promise.all([
      gitlabAccessToken(db, appKey, gitProviderId),
      gitlabWebhookSecret(db, appKey, gitProviderId),
    ]);

    // GitLab happily creates a second hook with the same URL, so the list is
    // what makes this idempotent.
    const existing = await listProjectHooks(url, token, repositoryFullName);
    const already = existing.find((h) => h.url === hookUrl);
    if (already) {
      await record(db, gitProviderId, repositoryFullName, hookUrl, {
        hookId: already.id,
        lastError: null,
      });
      return { error: null, repositoryFullName };
    }

    const created = await createProjectHook(url, token, repositoryFullName, {
      hookUrl,
      token: secret,
    });
    await record(db, gitProviderId, repositoryFullName, hookUrl, {
      hookId: created.id,
      lastError: null,
    });
    return { error: null, repositoryFullName };
  } catch (err) {
    const error = messageOf(err);
    await record(db, gitProviderId, repositoryFullName, hookUrl, {
      hookId: null,
      lastError: error,
    }).catch(() => null);
    return { error, repositoryFullName };
  }
}

async function removeRepositoryHook(
  db: Database,
  appKey: Buffer,
  row: typeof gitlabRepositoryHooks.$inferSelect
): Promise<void> {
  if (row.hookId) {
    const { token, url } = await gitlabAccessToken(
      db,
      appKey,
      row.gitProviderId
    );
    await deleteProjectHook(url, token, row.repositoryFullName, row.hookId);
  }
  await db
    .delete(gitlabRepositoryHooks)
    .where(
      and(
        eq(gitlabRepositoryHooks.gitProviderId, row.gitProviderId),
        eq(gitlabRepositoryHooks.repositoryFullName, row.repositoryFullName)
      )
    );
}

export interface ReconcileResult {
  failed: HookOutcome[];
  registered: string[];
  removed: string[];
}

/**
 * Repositories that justify a hook. Previews are excluded: the parent already
 * justifies one, and preview churn must not drive hook lifetime.
 */
async function justified(
  db: Database
): Promise<Map<string, { gitProviderId: string; repositoryFullName: string }>> {
  const rows = await db.query.services.findMany({
    with: { gitProvider: true },
  });
  const wanted = new Map<
    string,
    { gitProviderId: string; repositoryFullName: string }
  >();
  for (const s of rows) {
    if (
      s.previewOfServiceId === null &&
      s.gitProvider?.providerType === "gitlab" &&
      s.gitRepoFullName
    ) {
      wanted.set(`${s.gitProvider.id}:${s.gitRepoFullName}`, {
        gitProviderId: s.gitProvider.id,
        repositoryFullName: s.gitRepoFullName,
      });
    }
  }
  return wanted;
}

/**
 * Both directions: register what is justified and missing, remove orphans.
 * An orphan keeps getting 200s, so GitLab shows it delivering fine forever.
 */
export async function reconcileRepositoryHooks(
  db: Database,
  appKey: Buffer
): Promise<ReconcileResult> {
  const wanted = await justified(db);
  const rows = await db.query.gitlabRepositoryHooks.findMany();
  const result: ReconcileResult = { failed: [], registered: [], removed: [] };

  for (const row of rows) {
    const key = `${row.gitProviderId}:${row.repositoryFullName}`;
    if (wanted.has(key)) {
      wanted.delete(key);
      if (row.hookId) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one remote per repository, and a sweep has no deadline
      const outcome = await ensureRepositoryHook(db, appKey, {
        gitProviderId: row.gitProviderId,
        hookUrl: row.hookUrl,
        repositoryFullName: row.repositoryFullName,
      });
      if (outcome.error) {
        result.failed.push(outcome);
      } else {
        result.registered.push(row.repositoryFullName);
      }
      continue;
    }

    try {
      await removeRepositoryHook(db, appKey, row);
      result.removed.push(row.repositoryFullName);
    } catch (err) {
      result.failed.push({
        error: messageOf(err),
        repositoryFullName: row.repositoryFullName,
      });
    }
  }

  // Anything still wanted has no row, so no hook URL — only web knows the
  // public origin, and it writes the row even when registration fails.
  return result;
}
