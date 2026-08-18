import { encryptSecret, secretContext } from "@noddle/crypto";
import { servers, services, sshKeys } from "@noddle/db/schema";
import {
  deleteSshKeySchema,
  sshKeyInputSchema,
} from "@noddle/shared/validation/server";
import { generateKeyPair, publicKeyOf } from "@noddle/ssh-executor/keys";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded, runRead } from "@/lib/permission.server";

export interface SshKeyView {
  createdAt: string;
  id: string;
  name: string;
  /** `null` for a key carried over from before the library: the migration
   *  couldn't derive it, for lack of an APP_KEY in SQL. A gap, not an empty
   *  string that would pass for a valid public key. */
  publicKey: string | null;
  /** How many machines use it. This is what makes deletion understandable
   *  BEFORE attempting it, rather than a refusal after the fact. */
  serverCount: number;
}

export const getSshKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<SshKeyView[]> =>
    runRead({
      permission: { action: "read", resource: "sshKey" },
      read: async () => {
        // Neither read needs the other; in series the panel waited for the
        // sum of two round trips before it could answer.
        const [rows, machines] = await Promise.all([
          db.query.sshKeys.findMany({ orderBy: desc(sshKeys.createdAt) }),
          db.query.servers.findMany({ columns: { sshKeyId: true } }),
        ]);

        return rows.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          name: row.name,
          publicKey: row.publicKey,
          serverCount: machines.filter((m) => m.sshKeyId === row.id).length,
        }));
      },
    })
);

/**
 * Add a key, either by generating it or by pasting it.
 *
 * Returns the PUBLIC key, never the private one — even right after
 * generating it. This is the opposite of a webhook secret, shown once:
 * there, the value had to be handed to a third party; here the third party
 * (a machine, a repository) receives the public part, and the private one
 * has no reason to ever leave the server.
 */
export const createSshKey = createServerFn({ method: "POST" })
  .validator(sshKeyInputSchema)
  .handler(async ({ data }): Promise<{ publicKey: string }> => {
    // The created row is the audit object, and it does not exist until
    // `run` has made it — so the target reads the result, not a load.
    const guarded = await runGuarded({
      permission: { action: "create", resource: "sshKey" },
      run: async () => {
        const pair =
          data.mode === "generate"
            ? generateKeyPair(data.type, data.name)
            : {
                privateKey: data.privateKey,
                publicKey: publicKeyOf(data.privateKey),
              };

        if (!pair.publicKey) {
          // An unreadable key, or one protected by a passphrase. The refusal
          // happens here rather than at the first connection: discovering at
          // that point that the key doesn't open would leave a server
          // "unreachable" with no readable cause.
          throw new Error(
            "this private key could not be read: it may be malformed, or protected by a passphrase, which Noddle does not support"
          );
        }

        // The id is generated HERE: the AAD binds the ciphertext to the row, so
        // it must exist before encryption. Leaving it to `defaultRandom()`
        // would require writing a "placeholder" and then rewriting it.
        const id = crypto.randomUUID();
        await db.insert(sshKeys).values({
          id,
          name: data.name,
          privateKeyEncrypted: encryptSecret(
            pair.privateKey,
            env.appKey,
            secretContext.sshKey(id)
          ),
          publicKey: pair.publicKey,
        });

        return { id, name: data.name, publicKey: pair.publicKey };
      },
      target: ({ result }) => ({ id: result.id, name: result.name }),
    });
    return { publicKey: guarded.publicKey };
  });

/**
 * Remove a key.
 *
 * The refusal is the whole point, as with a server: the foreign key is
 * `restrict` and Postgres would reject it anyway, but with an error nobody
 * can read. We say what's blocking, and how much of it — and we say it
 * BEFORE attempting, since `serverCount` is already on screen.
 */
export const deleteSshKey = createServerFn({ method: "POST" })
  .validator(deleteSshKeySchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.sshKeys.findFirst({ where: eq(sshKeys.id, data.sshKeyId) }),
      notFoundMessage: "ssh key not found",
      permission: { action: "delete", resource: "sshKey" },
      run: async ({ row }) => {
        const used = await db.query.servers.findMany({
          where: eq(servers.sshKeyId, data.sshKeyId),
        });
        if (used.length > 0) {
          throw new Error(
            `this key still opens ${used.length} server(s): ${used
              .map((s) => s.name)
              .join(", ")}. Remove them first`
          );
        }

        // Same reasoning one table over: the FK is `restrict`, so the
        // delete would fail anyway — but with a constraint name instead
        // of the list of services that would stop deploying.
        const deploying = await db.query.services.findMany({
          where: eq(services.deployKeyId, data.sshKeyId),
        });
        if (deploying.length > 0) {
          throw new Error(
            `this key still clones for ${deploying.length} service(s): ${deploying
              .map((s) => s.name)
              .join(", ")}. Change their provider first`
          );
        }

        await db.delete(sshKeys).where(eq(sshKeys.id, row.id));
        return { ok: true };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
