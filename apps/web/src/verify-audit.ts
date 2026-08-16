// tier: local
//   bun run build && APP_KEY=… DATABASE_URL=… REDIS_URL=… bun run src/verify-audit.ts

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
  console.log(`  \x1B[32m✓\x1B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1B[31m✗\x1B[0m ${m}`);
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
      // Like a BROWSER, not like curl. better-auth rejects some endpoints
      // without `Origin` (`MISSING_OR_NULL_ORIGIN`) and accepts others —
      // that mismatch is what made the VPS check pass for the wrong reason
      // in Phase 3. A test harness that sends no `Origin` doesn't exercise
      // the real path.
      Origin: BASE,
      // A client IP, to verify that `x-forwarded-for` is properly READ: the
      // web process runs behind Traefik, so the socket's address would
      // always be the proxy's.
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
      // biome-ignore lint/performance/noAwaitInLoops: deliberate polling of startup
      const r = await fetch(`${BASE}/api/auth/ok`);
      if (r.ok) {
        return true;
      }
    } catch {
      // not ready yet
    }
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
    env: { ...process.env, PORT: String(PORT) },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (await waitForServer()) {
    ok("the built server responds");
  } else {
    ko("the server did not start");
    throw new Error("aborting");
  }

  // ── the owner ────────────────────────────────────────────────────────────
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

  // ── viewing the log does NOT log itself ──────────────────────────────────
  //
  // Otherwise every reload of /audit would write a "read · audit" line, and
  // since the screen only renders the last 200, a few refreshes would chase
  // the REAL events out of the window. The log would bury its own signal by
  // looking at itself.
  //
  // TWO visits, not one: a single one wouldn't tell "we don't write" apart
  // from "we wrote before counting".
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

  // ── does a REFUSAL leave a trace? ─────────────────────────────────────────
  //
  // This is the half that matters: a log that only keeps what succeeded
  // never shows someone probing around. It's also the line used to check
  // that the columns are FILLED IN, since it's now the only one /audit
  // produces.
  {
    // Through the REAL account-creation path — the one the `admin` plugin
    // uses, which `createAccount` also uses. Writing the row and a hash by
    // hand would build an account better-auth couldn't read back, and the
    // test would fail on its own setup rather than on the product.
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

    // The columns being FILLED IN, on this very line: it's the only one
    // /audit produces now that an authorized view is no longer logged. A
    // line written but empty would be no better than none.
    const row = denied.at(-1);
    // The address comes from `x-forwarded-for`, NOT from the socket:
    // without that every line would carry the proxy's, and the column
    // would say nothing.
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
    // And it really was refused — otherwise we'd be logging a refusal that
    // isn't one.
    // We look at the RENDERED content, not just the status: a refusal must
    // produce the "not available for your role" screen, not a crash page —
    // the server just did its job. Without `errorComponent`, a loader
    // exception rendered exactly that. Measured.
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

    // ── does the trace survive the account being deleted? ──────────────────
    //
    // THIS is the whole reason for a denormalized `actor_email` and
    // `ON DELETE SET NULL`. With a cascade — the obvious instinct — deleting
    // an account would erase what it did, which empties an audit log of its
    // only purpose.
    await db.delete(sessionTable).where(eq(sessionTable.userId, readerId));
    await db.delete(account).where(eq(account.userId, readerId));
    await db.delete(user).where(eq(user.id, readerId));

    // FIRST: is the account REALLY gone? Without this check, a deletion
    // that silently fails — a `restrict` foreign key, for instance — would
    // make the row "survive" for the wrong reason, and the next assertion
    // would pass green while proving nothing.
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
    // Surviving isn't enough: it still has to say WHO.
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
