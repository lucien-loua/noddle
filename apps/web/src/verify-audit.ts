// tier: local
import { setTimeout as sleep } from "node:timers/promises";

import { createDatabase } from "@noddle/db";
import {
  account,
  auditLog,
  session as sessionTable,
  user,
} from "@noddle/db/schema";
import { devStack } from "@noddle/testing/dev-stack";
import { and, eq } from "drizzle-orm";

const DB_URL = devStack().databaseUrl;
const PORT = Number(process.env.PORT ?? 3101);
const BASE = `http://localhost:${PORT}`;
const OWNER = "owner@noddle.test";
const READER = "reader@noddle.test";
const PASSWORD = "noddle-verify-audit";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \u001B[32m✓\u001B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \u001B[31m✗\u001B[0m ${m}`);
};

const db = createDatabase({ url: DB_URL });
let cookie = "";

async function call(
  path: string,
  init: RequestInit = {}
): Promise<{ body: string; response: Response }> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE,
      "x-forwarded-for": "198.51.100.9, 10.0.0.1",
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  }
  return { body: await response.text(), response };
}

const entriesFor = async (email: string, outcome: "allowed" | "denied") =>
  await db.query.auditLog.findMany({
    where: and(
      eq(auditLog.actorEmail, email),
      eq(auditLog.action, "read"),
      eq(auditLog.resource, "audit"),
      eq(auditLog.outcome, outcome)
    ),
  });

let server: ReturnType<typeof Bun.spawn> | undefined;

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/auth/ok`);
      if (r.ok) {
        return true;
      }
    } catch {}
    await sleep(500);
  }
  return false;
}

async function cleanup(): Promise<void> {
  await db.delete(auditLog);
  await db.delete(sessionTable);
  await db.delete(account);
  await db.delete(user);
}

try {
  await cleanup();

  server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, BETTER_AUTH_URL: BASE, PORT: String(PORT) },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (await waitForServer()) {
    ok("the built server responds");
  } else {
    ko("the server did not start");
    throw new Error("aborting");
  }

  await call("/api/auth/sign-up/email", {
    body: JSON.stringify({ email: OWNER, name: "owner", password: PASSWORD }),
    method: "POST",
  });
  const [ownerRow] = await db
    .select()
    .from(user)
    .where(eq(user.email, OWNER))
    .limit(1);
  if (!ownerRow) {
    throw new Error("owner account not found");
  }
  await db.update(user).set({ role: "owner" }).where(eq(user.id, ownerRow.id));

  await call("/api/auth/sign-in/email", {
    body: JSON.stringify({ email: OWNER, password: PASSWORD }),
    method: "POST",
  });

  {
    const before = (await entriesFor(OWNER, "allowed")).length;
    const first = await call("/audit");
    await call("/audit");
    const after = await entriesFor(OWNER, "allowed");

    if (first.response.status === 200 && after.length === before) {
      ok("two authorized views write no line at all");
    } else {
      ko(
        `viewing: status ${first.response.status}, ${after.length} line(s) instead of ${before}`
      );
    }
  }

  {
    const saved = cookie;
    const created = await call("/api/auth/admin/create-user", {
      body: JSON.stringify({
        email: READER,
        name: "reader",
        password: PASSWORD,
        role: "viewer",
      }),
      method: "POST",
    });
    if (!created.response.ok) {
      ko(`creating the reader: ${created.response.status} ${created.body}`);
      throw new Error("aborting");
    }
    const readerId = await pickUser(READER);
    if (!readerId) {
      throw new Error("reader not found after creation");
    }

    cookie = "";
    const signIn = await call("/api/auth/sign-in/email", {
      body: JSON.stringify({ email: READER, password: PASSWORD }),
      method: "POST",
    });
    if (!signIn.response.ok) {
      ko(`the reader could not sign in (${signIn.response.status})`);
      throw new Error("aborting");
    }

    const before = (await entriesFor(READER, "denied")).length;
    const { body, response } = await call("/audit");
    const denied = await entriesFor(READER, "denied");

    if (denied.length === before + 1) {
      ok("a REFUSAL is logged (outcome = denied)");
    } else {
      ko(`refusal: ${denied.length} line(s) instead of ${before + 1}`);
    }

    const row = denied.at(-1);
    if (row?.ipAddress === "198.51.100.9") {
      ok("the recorded address is the CLIENT's, not the proxy's");
    } else {
      ko(`recorded address: ${row?.ipAddress ?? "none"}`);
    }
    if (row?.role === "viewer") {
      ok("the role AT THE TIME OF THE EVENT is recorded");
    } else {
      ko(`recorded role: ${row?.role ?? "none"}`);
    }
    const polite = body.includes("Not available for your role");
    if (response.status !== 200 && polite) {
      ok("the refusal renders the intended screen, not a crash page");
    } else {
      ko(
        `refusal: status ${response.status}, expected screen ${polite ? "present" : "ABSENT"}`
      );
    }
    const allowedForReader = await entriesFor(READER, "allowed");
    if (allowedForReader.length === 0) {
      ok('no "allowed" line under the reader\'s name');
    } else {
      ko(`${allowedForReader.length} "allowed" line(s) for someone refused`);
    }

    cookie = saved;

    await db.delete(sessionTable).where(eq(sessionTable.userId, readerId));
    await db.delete(account).where(eq(account.userId, readerId));
    await db.delete(user).where(eq(user.id, readerId));

    if ((await pickUser(READER)) === undefined) {
      ok("the account is truly deleted");
    } else {
      ko("the account still exists: the line surviving proves nothing");
    }

    const survivors = await entriesFor(READER, "denied");
    if (survivors.length >= 1) {
      ok("the line survives the account's deletion");
    } else {
      ko(
        "the line vanished with the account — the log no longer proves anything"
      );
    }
    const orphan = survivors.at(-1);
    if (orphan?.actorEmail === READER && orphan.actorUserId === null) {
      ok("it still names its author, and the foreign key is unlinked");
    } else {
      ko(
        `after deletion: email "${orphan?.actorEmail}", userId "${orphan?.actorUserId}"`
      );
    }
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  server?.kill();
  await cleanup();
}

async function pickUser(email: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  return row?.id;
}

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);
