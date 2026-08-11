/**
 * Shared preamble for mutating server functions: permission, target
 * resolution, optional confirm-name, then the handler's decision.
 *
 * Audit `recordPerformed` runs only after `run` returns, so refusals never
 * look like successes. Callers keep owning `createServerFn` + `.validator`
 * so TanStack's types stay intact.
 */

import type { Session } from "@/lib/auth.server";
import { recordPerformed, requirePermission } from "@/lib/permission.server";
import type { Permission } from "@/lib/permissions";

export async function runGuardedMutation<TRow, TResult>(opts: {
  permission: Permission;
  load: () => Promise<TRow | null | undefined>;
  confirmName?: { expected: (row: TRow) => string; typed: string };
  idOf: (row: TRow) => string;
  nameOf?: (row: TRow) => string | null;
  notFoundMessage?: string;
  run: (ctx: { row: TRow; session: Session }) => Promise<TResult>;
}): Promise<TResult> {
  const session = await requirePermission(opts.permission);
  const row = (await opts.load()) ?? null;
  if (!row) {
    throw new Error(opts.notFoundMessage ?? "not found");
  }
  if (opts.confirmName) {
    const expected = opts.confirmName.expected(row);
    if (opts.confirmName.typed !== expected) {
      throw new Error(
        `the name you typed does not match "${expected}" — cancelled`
      );
    }
  }
  const result = await opts.run({ row, session });
  await recordPerformed(session, opts.permission, {
    id: opts.idOf(row),
    name: opts.nameOf?.(row) ?? null,
  });
  return result;
}
