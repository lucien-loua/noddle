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

export async function reconcileRepositoryHooks(
  db: Database,
  appKey: Buffer
): Promise<ReconcileResult> {
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

  return result;
}
