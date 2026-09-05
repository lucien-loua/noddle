import { user } from "@noddle/db/schema";
import {
  accountRoleSchema,
  createAccountSchema,
  deleteAccountSchema,
} from "@noddle/shared/validation/account";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { emailTarget, guarded } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface AccountRow {
  createdAt: string;
  email: string;
  id: string;
  isSelf: boolean;
  name: string;
  role: string;
}

export const getAccounts = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccountRow[]> => {
    const session = await requireSession();
    const rows = await db.query.user.findMany({ orderBy: user.createdAt });
    return rows.map((u) => ({
      createdAt: u.createdAt.toISOString(),
      email: u.email,
      id: u.id,
      isSelf: u.id === session.user.id,
      name: u.name,
      role: u.role ?? "viewer",
    }));
  }
);

export const createAccount = createServerFn({ method: "POST" })
  .validator(createAccountSchema)
  .handler(async ({ data }): Promise<{ password: string }> => {
    const outcome = await runGuarded({
      permission: { action: "create", resource: "user" },
      run: async () => {
        const password = crypto.randomUUID().replaceAll("-", "");

        const account = await auth.api.createUser({
          body: {
            email: data.email,
            name: data.name,
            password,
            role: data.role,
          },
          headers: getRequestHeaders(),
        });

        return { id: account.user.id, password };
      },
      target: ({ result }) => ({ id: result.id, name: data.email }),
    });

    return { password: outcome.password };
  });

export const setAccountRole = createServerFn({ method: "POST" })
  .validator(accountRoleSchema)
  .handler(async ({ data }): Promise<{ saved: true }> =>
    runGuarded({
      ...guarded.account(data.userId),
      permission: { action: "set-role", resource: "user" },
      run: async ({ row }) => {
        await assertNotLastOwner(row.id, data.role);

        await auth.api.setRole({
          body: { role: data.role, userId: row.id },
          headers: getRequestHeaders(),
        });
        return { saved: true as const };
      },
      target: emailTarget,
    })
  );

export const removeAccount = createServerFn({ method: "POST" })
  .validator(deleteAccountSchema)
  .handler(async ({ data }): Promise<{ removed: true }> =>
    runGuarded({
      ...guarded.account(data.userId),
      permission: { action: "delete", resource: "user" },
      run: async ({ row, session }) => {
        if (row.id === session.user.id) {
          throw new Error("You cannot delete your own account.");
        }
        if (data.confirmEmail !== row.email) {
          throw new Error("The address typed does not match this account.");
        }

        await assertNotLastOwner(row.id, "viewer");

        await auth.api.removeUser({
          body: { userId: row.id },
          headers: getRequestHeaders(),
        });
        return { removed: true };
      },
      target: emailTarget,
    })
  );

async function assertNotLastOwner(
  targetId: string,
  nextRole: string
): Promise<void> {
  const target = await db.query.user.findFirst({
    where: eq(user.id, targetId),
  });
  if (target?.role !== "owner" || nextRole === "owner") {
    return;
  }
  const owners = await db.query.user.findMany({
    where: eq(user.role, "owner"),
  });
  if (owners.length <= 1) {
    throw new Error(
      "This account is the last owner. Removing it would leave the installation with nobody able to grant access."
    );
  }
}
