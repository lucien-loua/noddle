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
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded, runRead } from "@/lib/permission.server";

export interface SshKeyView {
  createdAt: string;
  id: string;
  name: string;
  publicKey: string | null;
  serverCount: number;
}

export const getSshKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<SshKeyView[]> =>
    runRead({
      permission: { action: "read", resource: "sshKey" },
      read: async () => {
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

export const createSshKey = createServerFn({ method: "POST" })
  .validator(sshKeyInputSchema)
  .handler(async ({ data }): Promise<{ publicKey: string }> => {
    const outcome = await runGuarded({
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
          throw new Error(
            "this private key could not be read: it may be malformed, or protected by a passphrase, which Noddle does not support"
          );
        }

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
    return { publicKey: outcome.publicKey };
  });

export const deleteSshKey = createServerFn({ method: "POST" })
  .validator(deleteSshKeySchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.sshKey(data.sshKeyId),
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
      target: identityTarget,
    })
  );
