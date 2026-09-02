// tier: fixture
import { encryptSecret, secretContext } from "@noddle/crypto";
import type { Database } from "@noddle/db";
import { sshKeys } from "@noddle/db/schema";
import type { RegistryConfig } from "@noddle/registry";
import { eq } from "drizzle-orm";

import { createDeployContext } from "#runtime-context";
import type { BuildOptions, DeployContext } from "#runtime-context";

export function verifyBuild(name: string): BuildOptions {
  return { logRoot: `/tmp/noddle-verify-${name}-logs` };
}

export async function seedSshKey(
  db: Database,
  appKey: Buffer,
  name: string,
  privateKey: string
): Promise<string> {
  const existing = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.name, name),
  });
  const id = existing?.id ?? crypto.randomUUID();
  const values = {
    id,
    name,
    privateKeyEncrypted: encryptSecret(
      privateKey,
      appKey,
      secretContext.sshKey(id)
    ),
  };

  if (existing) {
    await db.update(sshKeys).set(values).where(eq(sshKeys.id, id));
  } else {
    await db.insert(sshKeys).values(values);
  }
  return id;
}

export function verifyCtx(core: {
  appKey: Buffer;
  db: Database;
  registry?: RegistryConfig;
}): DeployContext {
  return createDeployContext(core);
}
