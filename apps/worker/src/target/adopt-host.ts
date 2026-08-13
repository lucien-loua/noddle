//   DATABASE_URL=… APP_KEY=… HOST_IP=… HOST_USER=… HOST_SSH_KEY=… \
//     node src/adopt-host.ts
//
// Idempotent: rerunning the installer does not create a second server.
import { readFileSync } from "node:fs";
import { encryptSecret, loadAppKey, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { servers, sshKeys } from "@noddle/db/schema";
import { ensureRegistryTrust } from "@noddle/registry";
import { connect, disconnect, dockerClient } from "@noddle/ssh-executor";
import { publicKeyOf } from "@noddle/ssh-executor/keys";
import { getSwarmNodeId } from "@noddle/swarm-ops";
import { and, eq } from "drizzle-orm";
import { loadRegistryConfig } from "#registry";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`required environment variable: ${name}`);
  }
  return value;
}

const db = createDatabase({ url: required("DATABASE_URL") });
const appKey = loadAppKey(process.env.APP_KEY);

const host = required("HOST_IP");
const user = required("HOST_USER");
const port = Number(process.env.HOST_SSH_PORT ?? 22);
const privateKey = readFileSync(required("HOST_SSH_KEY"), "utf8");
const registry = loadRegistryConfig();

/** Records the same facts as `provisionServer` for a machine added to the
 *  fleet, and through the SAME path: a real SSH connection, then the
 *  Docker socket through it.
 *
 *  Without this, machine #1 stayed at `pending` forever — the dashboard
 *  showed "Provisioning…" for a server that was already building and
 *  deploying. This is the single-machine case, so the common case, and a
 *  screen whose only job is to say "is it OK" was wrong for everyone.
 *
 *  Marking it `connected` without checking would have been just as wrong,
 *  in the other direction: this is where, at install time, the loopback
 *  path has to be exercised for the first time. */
async function recordReachability(serverId: string): Promise<void> {
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    client = await connect({ host, port, privateKey, user });

    // Machine #1 is a node like any other: it must trust the registry to
    // pull the images it built itself. On a single-machine installation —
    // the common case — this is the ONLY place that trust gets set up, so
    // the loopback path is exercised by everyone, like the rest of the
    // adoption.
    if (registry) {
      await ensureRegistryTrust(client, registry);
      process.stdout.write(`  registry credentials saved (${registry.host})\n`);
    }

    const docker = dockerClient(client);
    const info = (await docker.info()) as { MemTotal?: number };
    const version = (await docker.version()) as {
      MinAPIVersion?: string;
      Version?: string;
    };
    await db
      .update(servers)
      .set({
        dockerApiMinVersion: version.MinAPIVersion ?? null,
        dockerVersion: version.Version ?? null,
        lastError: null,
        status: "connected",
        swarmNodeId: await getSwarmNodeId(docker),
        totalMemoryMb: info.MemTotal
          ? Math.round(info.MemTotal / 1024 / 1024)
          : null,
      })
      .where(eq(servers.id, serverId));
    process.stdout.write(`  reachable: Docker ${version.Version ?? "?"}\n`);
  } catch (err) {
    // The installation does NOT fail because of this: the stack is
    // running, the administrator account can be created, and the
    // dashboard must be able to show WHY the machine is unreachable.
    // Exiting with an error here would leave the user staring at an empty
    // screen with no explanation.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(servers)
      .set({ lastError: message, status: "unreachable" })
      .where(eq(servers.id, serverId));
    process.stdout.write(`  unreachable: ${message}\n`);
  } finally {
    if (client) {
      disconnect(client);
    }
  }
}

// Uniqueness is (host, port, user) in the database; we query the same
// combination rather than a flag, so that reinstalling on top of an
// existing installation lands on the same row.
const existing = await db.query.servers.findFirst({
  where: and(
    eq(servers.host, host),
    eq(servers.sshPort, port),
    eq(servers.sshUser, user)
  ),
});

/**
 * The installer's key, IN the library.
 *
 * This is what makes it so there's only one kind of server: machine #1 is
 * adopted with no human involved, and yet its key ends up in the same
 * place as the ones added later from the browser. So the library is never
 * empty on a fresh installation, and the screen for adding a second server
 * already has something to offer.
 *
 * Find-or-create by NAME, and rewrites the key on every run: reinstalling
 * over an existing installation may have regenerated the pair.
 */
async function seedInstallerKey(): Promise<string> {
  // The name is also the LOOKUP KEY for this find-or-create: changing it on
  // a running installation would create a second key instead of rewriting
  // the first. No consequence today — the library has never shipped — but
  // one to leave alone from now on.
  const name = "Noddle host";
  const found = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.name, name),
  });
  // The id is drawn HERE, not left to `defaultRandom()`: the AAD binds the
  // ciphertext to the row, so it must be known BEFORE encrypting. Drawing
  // it on the database side would require inserting a "placeholder" and
  // then rewriting it.
  const id = found?.id ?? crypto.randomUUID();
  const values = {
    id,
    name,
    privateKeyEncrypted: encryptSecret(
      privateKey,
      appKey,
      secretContext.sshKey(id)
    ),
    publicKey: publicKeyOf(privateKey),
  };

  if (found) {
    await db.update(sshKeys).set(values).where(eq(sshKeys.id, id));
  } else {
    await db.insert(sshKeys).values(values);
  }
  return id;
}

const sshKeyId = await seedInstallerKey();

if (existing) {
  // The key is already rewritten in the library; here we only REFERENCE
  // it. That's the whole point of this change: the value lives in one
  // place, so rotation only has one place to touch.
  //
  // `role: "manager"` is rewritten here too, not only on creation: it's
  // `isSelf`, a display column, that stays the source of truth for "which
  // machine ran the installer". `role` carries the orchestration fact —
  // two independent columns that, as of Phase 2, ALWAYS describe the same
  // row, because this machine is the only one to have run
  // `docker swarm init`, never because one is derived from the other.
  await db
    .update(servers)
    .set({ isSelf: true, role: "manager", sshKeyId })
    .where(eq(servers.id, existing.id));
  process.stdout.write(`server #1 already registered (${existing.id})\n`);
  await recordReachability(existing.id);
} else {
  // No more two-step insert: the AAD now binds the ciphertext to the KEY's
  // row, not the server's, and that row already exists.
  const [created] = await db
    .insert(servers)
    .values({
      host,
      isSelf: true,
      name: process.env.HOST_NAME ?? "this machine",
      role: "manager",
      sshKeyId,
      sshPort: port,
      sshUser: user,
    })
    .returning();
  if (!created) {
    throw new Error("could not register the server");
  }
  process.stdout.write(`server #1 registered (${created.id})\n`);
  await recordReachability(created.id);
}

process.exit(0);
