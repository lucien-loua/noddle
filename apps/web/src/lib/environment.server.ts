import { environments } from "@noddle/db/schema";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";

/**
 * Inserts an environment, marking it default when the project has none yet.
 *
 * `createProject`, connect-repo/stack/database and `createEnvironment` all
 * go through here: the first environment of a project is the default, and
 * every later one is not. Preview stays out — it is never the default.
 */
export async function insertProjectEnvironment(values: {
  description?: string | null;
  name: string;
  projectId: string;
}): Promise<typeof environments.$inferSelect> {
  const existingDefault = await db.query.environments.findFirst({
    columns: { id: true },
    where: and(eq(environments.projectId, values.projectId), eq(environments.isDefault, true)),
  });
  const [created] = await db
    .insert(environments)
    .values({
      description: values.description,
      isDefault: !existingDefault,
      name: values.name,
      projectId: values.projectId,
    })
    .returning();
  if (!created) {
    throw new Error("could not create environment");
  }
  return created;
}
