import { setTimeout as sleep } from "node:timers/promises";
import { databases, stacks } from "@noddle/db/schema";
import type { DockerApi } from "@noddle/ssh-executor";
import { execArgv } from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";
import { removeSecretIfExists } from "#database";
import { type DeployClients, withDeployClients } from "#job-run";
import type { DeployContext } from "#runtime-context";

// Docker 29 answers "volume <name> not found", not "no such volume" —
// measured against a real VM. Both forms are tolerated in case an earlier
// version still answers with the old one.
const VOLUME_ALREADY_GONE = /not found|no such volume/i;

type StackRow = NonNullable<Awaited<ReturnType<typeof loadStackForTeardown>>>;
type DatabaseRow = NonNullable<
  Awaited<ReturnType<typeof loadDatabaseForTeardown>>
>;

function loadStackForTeardown(ctx: DeployContext, stackId: string) {
  return ctx.db.query.stacks.findFirst({
    where: eq(stacks.id, stackId),
    with: { server: true },
  });
}

function loadDatabaseForTeardown(ctx: DeployContext, databaseId: string) {
  return ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
}

/**
 * The Swarm removal and its readback. Hoisted out of `runStackTeardown` so
 * the guard's closure does not push an already dense function past the
 * complexity ceiling.
 */
async function teardownStack(
  ctx: DeployContext,
  stack: StackRow,
  clients: DeployClients
): Promise<void> {
  // Swarm commands go through the MANAGER; only it holds the cluster's
  // replicated state.
  const { managerClient, managerDocker } = clients;

  // ── 1. Swarm — must succeed ────────────────────────────────────────────
  const removed = await execArgv(managerClient, [
    "sudo",
    "docker",
    "stack",
    "rm",
    stack.swarmName,
  ]);
  // An absent stack is NOT an error: `docker stack rm` on an unknown name
  // returns a message and a non-zero code, while the desired result —
  // nothing left running — is already reached. Only block on something
  // else.
  if (removed.code !== 0 && !removed.stderr.includes("Nothing found")) {
    throw new Error(
      `docker stack rm failed (${removed.code}): ${removed.stderr.slice(0, 300)}`
    );
  }

  // `docker stack rm` returns BEFORE the services have disappeared — same
  // trap as `docker service update`, already paid on stack deploy. Wait for
  // their real disappearance, otherwise the row would leave while Traefik
  // is still routing.
  await waitForStackGone(managerDocker, stack.swarmName);

  // ── 2. the database ─────────────────────────────────────────────────────
  // `stack_deployments` and `stack_deployment_logs` go in cascade.
  await ctx.db.delete(stacks).where(eq(stacks.id, stack.id));
}

/**
 * Remove the stack from Swarm, then its row.
 *
 * `docker stack rm` rather than a `removeService` loop: it's the command
 * that knows EVERYTHING the stack created — services, but also the
 * `<stack>_default` network that Compose fabricates and that a loop over
 * services would leave behind.
 */
export async function runStackTeardown(
  ctx: DeployContext,
  stackId: string
): Promise<void> {
  const stack = await loadStackForTeardown(ctx, stackId);
  if (!stack) {
    // Already deleted, or job replayed. The desired result is reached: this
    // is not an error.
    return;
  }

  try {
    // The connection lives inside `withDeployClients`: a failed key decrypt
    // must also write to `last_error`, as for a service, and the catch
    // below covers that case the same way it covers every other.
    await withDeployClients(ctx, stack.server, (clients) =>
      teardownStack(ctx, stack, clients)
    );
  } catch (err) {
    // If step 2 already succeeded, the row no longer exists: the UPDATE
    // then touches nothing, which is the desired result.
    await ctx.db
      .update(stacks)
      .set({ lastError: err instanceof Error ? err.message : String(err) })
      .where(eq(stacks.id, stackId));
    throw err;
  }
}

/** Wait until no service still carries the stack's prefix. */
async function waitForStackGone(
  docker: DockerApi,
  swarmName: string,
  seconds = 60
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: deliberate polling
    const left = await docker.listServices({
      filters: JSON.stringify({ name: [`${swarmName}_`] }),
    });
    if (left.length === 0) {
      return;
    }
    await sleep(2000);
  }
}

/**
 * The Swarm service, its secret, then every volume. Hoisted out of
 * `runDatabaseTeardown` for the same reason as `teardownStack`.
 */
async function teardownDatabase(
  ctx: DeployContext,
  database: DatabaseRow,
  clients: DeployClients
): Promise<void> {
  const { buildClient, managerDocker } = clients;

  // ── 1. the Swarm service — must succeed ──────────────────────────────
  await removeService(managerDocker, database.swarmName);

  // Docker refuses to delete a secret still attached to a service — so
  // AFTER step 1, never before. Best-effort: an orphan secret is a cleanup
  // debt, not lost data, see the function.
  await removeSecretIfExists(managerDocker, `${database.swarmName}-password`);

  // ── 2. the VOLUME, on the node that holds it ─────────────────────────
  // Never via the manager when the two differ: a named volume is LOCAL to
  // the node, and that's the whole reason a database is pinned. A retry
  // loop because it stays locked for a few moments by the container we
  // just removed. Extra named volumes from Advanced → Volumes go the same
  // way.
  const volumeNames = [
    database.swarmName,
    ...database.extraMounts
      .filter((m) => m.type === "volume")
      .map((m) => m.source),
  ];
  for (const volumeName of volumeNames) {
    let volumeGone = false;
    for (let i = 0; i < 20; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: deliberate retry
      const res = await execArgv(buildClient, [
        "sudo",
        "docker",
        "volume",
        "rm",
        volumeName,
      ]);
      if (res.code === 0 || VOLUME_ALREADY_GONE.test(res.stderr)) {
        volumeGone = true;
        break;
      }
      await sleep(1000);
    }
    if (!volumeGone) {
      throw new Error(
        `volume ${volumeName} could not be removed — the database row is kept so it stays visible`
      );
    }
  }

  // ── 3. the database ────────────────────────────────────────────────────
  // `backups` go in cascade. The S3 backup OBJECTS, though, remain: they
  // deliberately outlive the database they protected, otherwise deleting a
  // database would also destroy the only way to get it back.
  await ctx.db.delete(databases).where(eq(databases.id, database.id));
}

/**
 * Remove the database's Swarm service, THEN its volume, then the row.
 *
 * Volume-after-service order is not cosmetic: Docker refuses to delete a
 * volume that is still mounted, so the reverse would always fail.
 */
export async function runDatabaseTeardown(
  ctx: DeployContext,
  databaseId: string
): Promise<void> {
  const database = await loadDatabaseForTeardown(ctx, databaseId);
  if (!database) {
    return;
  }

  try {
    await withDeployClients(ctx, database.server, (clients) =>
      teardownDatabase(ctx, database, clients)
    );
  } catch (err) {
    await ctx.db
      .update(databases)
      .set({ lastError: err instanceof Error ? err.message : String(err) })
      .where(eq(databases.id, databaseId));
    throw err;
  }
}
