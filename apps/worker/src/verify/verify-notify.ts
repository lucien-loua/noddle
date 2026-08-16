// tier: local
// node apps/worker/src/verify/verify-notify.ts
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { notificationChannels } from "@noddle/db/schema";
import { devStack } from "@noddle/testing/dev-stack";
import { eq } from "drizzle-orm";

import { notify } from "#notify";
import { verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1B[32m✓\x1B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1B[31m✗\x1B[0m ${m}`);
};

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const ctx = verifyCtx({ appKey, db });

let hits = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits += 1;
    res.writeHead(204).end();
  });
});
await new Promise<void>((r) => {
  server.listen(0, "127.0.0.1", () => r());
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const receiver = `http://127.0.0.1:${port}/`;

async function addChannel(opts: {
  enabled?: boolean;
  name: string;
  notifySuccess?: boolean;
  url: string;
}): Promise<string> {
  const [row] = await db
    .insert(notificationChannels)
    .values({
      enabled: opts.enabled ?? true,
      kind: "webhook",
      name: opts.name,
      notifySuccess: opts.notifySuccess ?? false,
      urlEncrypted: "placeholder",
    })
    .returning();
  const id = row?.id ?? "";
  // Encryption is bound to the row's id (AAD): the row must exist first.
  await db
    .update(notificationChannels)
    .set({
      urlEncrypted: encryptSecret(
        opts.url,
        appKey,
        secretContext.notificationChannel(id)
      ),
    })
    .where(eq(notificationChannels.id, id));
  return id;
}

console.log("\n\x1B[1mNotification delivery — real Postgres + HTTP\x1B[0m");

await db.delete(notificationChannels);

try {
  const live = await addChannel({ name: "actif", url: receiver });
  const off = await addChannel({
    enabled: false,
    name: "coupe",
    url: receiver,
  });

  // ── 1. A failure reaches the active channel, exactly once ────────────────
  hits = 0;
  await notify(ctx, {
    detail: "exit 1",
    resource: "api",
    type: "deploy_failed",
  });
  if (hits === 1) {
    ok(
      "a failure reaches the active channel, and only it (disabled channel ignored)"
    );
  } else {
    ko(`${hits} send(s), expected 1`);
  }

  const after = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, live),
  });
  if (after?.lastSuccessAt && !after.lastError) {
    ok("the success is timestamped on the channel");
  } else {
    ko(`lastSuccessAt=${after?.lastSuccessAt} lastError=${after?.lastError}`);
  }

  const offRow = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, off),
  });
  if (offRow?.lastSuccessAt) {
    ko("the disabled channel received a send");
  } else {
    ok("the disabled channel received nothing");
  }

  // ── 2. A SUCCESS only reaches channels that requested it ─────────────────
  hits = 0;
  await notify(ctx, { resource: "api", type: "deploy_succeeded" });
  if (hits === 0) {
    ok("a success does not reach a channel that didn't request it");
  } else {
    ko(`a success was sent to ${hits} non-requesting channel(s)`);
  }

  await addChannel({ name: "verbeux", notifySuccess: true, url: receiver });
  hits = 0;
  await notify(ctx, { resource: "api", type: "deploy_succeeded" });
  if (hits === 1) {
    ok("a success reaches the channel that requested it");
  } else {
    ko(`${hits} send(s) for a success, expected 1`);
  }

  // ── 3. A broken channel: cause recorded, caller spared ───────────────────
  await db.delete(notificationChannels);
  const broken = await addChannel({
    name: "casse",
    url: "https://hote-inexistant.invalid/x",
  });

  let threw = false;
  try {
    await notify(ctx, { resource: "api", type: "deploy_failed" });
  } catch {
    threw = true;
  }
  if (threw) {
    ko("notify threw — a broken channel would fail the deployment");
  } else {
    ok("notify does not throw when a channel is unreachable");
  }

  const brokenRow = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, broken),
  });
  if (brokenRow?.lastError) {
    ok(`the failure is recorded: ${brokenRow.lastError.slice(0, 45)}`);
  } else {
    ko("no cause recorded — the failure would be invisible");
  }

  // ── 4. A failure followed by a success clears the error ──────────────────
  // Otherwise the screen would keep showing an error that's since been
  // resolved, and we'd end up ignoring the indicator.
  await db
    .update(notificationChannels)
    .set({
      urlEncrypted: encryptSecret(
        receiver,
        appKey,
        secretContext.notificationChannel(broken)
      ),
    })
    .where(eq(notificationChannels.id, broken));
  await notify(ctx, { resource: "api", type: "deploy_failed" });
  const healed = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, broken),
  });
  if (healed?.lastError === null && healed.lastSuccessAt) {
    ok("a success clears the previous error");
  } else {
    ko(`error not cleared: ${healed?.lastError}`);
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await db.delete(notificationChannels);
  server.close();
}

console.log(`\n\x1B[1mpassed ${pass}, failed ${fail}\x1B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
