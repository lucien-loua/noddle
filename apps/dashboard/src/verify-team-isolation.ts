// tier: local
import { randomBytes } from "node:crypto";

import { createDatabase } from "@noddle/db";
import { environments, organization, projects } from "@noddle/db/schema";
import { check, runVerify, suite } from "@noddle/testing";
import { devStack } from "@noddle/testing/dev-stack";
import { inArray } from "drizzle-orm";

import { listProjects } from "@/lib/team-queries.server";

const db = createDatabase({ url: devStack().databaseUrl });
const tag = randomBytes(4).toString("hex");
const teamA = `iso-a-${tag}`;
const teamB = `iso-b-${tag}`;

await db.insert(organization).values([
  { id: teamA, name: "Isolation A", slug: teamA },
  { id: teamB, name: "Isolation B", slug: teamB },
]);
const [projectA, projectB] = await db
  .insert(projects)
  .values([
    { name: `proj-a-${tag}`, teamId: teamA },
    { name: `proj-b-${tag}`, teamId: teamB },
  ])
  .returning();
await db.insert(environments).values([
  { isDefault: true, name: "production", projectId: projectA?.id as string },
  { isDefault: true, name: "production", projectId: projectB?.id as string },
]);

const idsOf = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

try {
  await runVerify("team isolation", async () => {
    await suite("a team sees its own projects and nothing else", async () => {
      const seenByA = idsOf(await listProjects(db, teamA));
      check("A sees its own project", seenByA.has(projectA?.id as string));
      check(
        "A does not see B's project",
        !seenByA.has(projectB?.id as string),
        "listProjects returned another team's row"
      );

      const seenByB = idsOf(await listProjects(db, teamB));
      check("B sees its own project", seenByB.has(projectB?.id as string));
      check("B does not see A's project", !seenByB.has(projectA?.id as string));
    });
  });
} finally {
  await db
    .delete(projects)
    .where(inArray(projects.id, [projectA?.id, projectB?.id] as string[]));
  await db.delete(organization).where(inArray(organization.id, [teamA, teamB]));
  process.exit(process.exitCode ?? 0);
}
