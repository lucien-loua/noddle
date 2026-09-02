import { environments } from "@noddle/db/schema";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";

export async function insertProjectEnvironment(values: {
  description?: string | null;
  name: string;
  projectId: string;
}): Promise<typeof environments.$inferSelect> {
  const existingDefault = await db.query.environments.findFirst({
    columns: { id: true },
    where: and(
      eq(environments.projectId, values.projectId),
      eq(environments.isDefault, true)
    ),
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
