// tier: fixture
// Common fixture setup for the benches: registering a key in the vault.
//
// Shared between VERIFICATIONS only, never with the product. The distinction
// matters: sharing the code of a test and the code it tests would let both
// go through the same defect — that's why `verify-registry.ts` reproduces
// `install.sh`'s openssl commands instead of sharing them. There's nothing
// to test here, just thirteen scripts that needed the same bit of fixture
// setup.

import { encryptSecret, secretContext } from "@noddle/crypto";
import type { Database } from "@noddle/db";
import { sshKeys } from "@noddle/db/schema";
import type { RegistryConfig } from "@noddle/registry";
import { eq } from "drizzle-orm";

import { createDeployContext } from "#runtime-context";
import type { DeployContext } from "#runtime-context";

/**
 * A key in the vault, encrypted, ready to be referenced by a server.
 *
 * The id is drawn HERE rather than left to `defaultRandom()`, and that's
 * what allows writing everything in ONE insert: the AAD binds the
 * ciphertext to the row, so the id must be known before encrypting. Doing
 * it database-side required inserting a "placeholder" then rewriting it —
 * the two-step dance that used to be found everywhere.
 */
export async function seedSshKey(
  db: Database,
  appKey: Buffer,
  name: string,
  privateKey: string,
): Promise<string> {
  // REPLAYABLE, and that's not a detail: the name is unique in the
  // database, and these scripts' `reset()` deletes servers without touching
  // keys — so a previous run's key is still there. A blind insert would
  // make every second run fail on a uniqueness violation, with the fixture
  // setup blaming the code. Same trap as the named volume that survives
  // `removeService`, already paid on verify-database.
  //
  // Re-encrypted on every run: `appKey` is drawn at random each time, so
  // last time's ciphertext is unreadable today.
  const existing = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.name, name),
  });
  const id = existing?.id ?? crypto.randomUUID();
  const values = {
    id,
    name,
    privateKeyEncrypted: encryptSecret(privateKey, appKey, secretContext.sshKey(id)),
  };

  if (existing) {
    await db.update(sshKeys).set(values).where(eq(sshKeys.id, id));
  } else {
    await db.insert(sshKeys).values(values);
  }
  return id;
}

/** DeployContext with production SSH/docker connectors for VM verification scripts. */
export function verifyCtx(core: {
  appKey: Buffer;
  db: Database;
  registry?: RegistryConfig;
}): DeployContext {
  return createDeployContext(core);
}
