import type { Database } from "@noddle/db";
import { gitlabRepositoryHooks } from "@noddle/db/schema";
import {
  createProjectHook,
  deleteProjectHook,
  listProjectHooks,
  updateProjectHook,
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

    // Ours is the one whose path names this connection — NOT the one whose
    // URL matches exactly. The dashboard's public origin moves (an ngrok
    // domain every restart, a real domain once), and matching on the whole
    // URL would create a second hook and orphan the first on GitLab, with
    // its id no longer recorded anywhere.
    const existing = await listProjectHooks(url, token, repositoryFullName);
    const mine = existing.find((h) => h.url.endsWith(`/${gitProviderId}`));
    if (mine) {
      const hook =
        mine.url === hookUrl
          ? mine
          : await updateProjectHook(url, token, repositoryFullName, mine.id, {
              hookUrl,
              token: secret,
            });
      await record(db, gitProviderId, repositoryFullName, hookUrl, {
        hookId: hook.id,
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
  } catch (error) {
    // The catch binding keeps the name the linter requires; the derived
    // message takes its own, or the two collide and the whole failure path
    // throws a ReferenceError instead of recording the failure.
    const message = messageOf(error);
    await record(db, gitProviderId, repositoryFullName, hookUrl, {
      hookId: null,
      lastError: message,
    }).catch(() => null);
    return { error: message, repositoryFullName };
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
  // What SHOULD exist and what DOES are read from different tables; asking
  // for them in turn only makes the reconciliation slower to start.
  const [wanted, rows] = await Promise.all([
    justified(db),
    db.query.gitlabRepositoryHooks.findMany(),
  ]);
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
    } catch (error) {
      result.failed.push({
        error: messageOf(error),
        repositoryFullName: row.repositoryFullName,
      });
    }
  }

  // Anything still wanted has no row, so no hook URL — only web knows the
  // public origin, and it writes the row even when registration fails.
  return result;
}
