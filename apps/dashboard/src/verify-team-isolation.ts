// tier: local
import { randomBytes } from "node:crypto";

import { createDatabase } from "@noddle/db";
import {
  envVars,
  environments,
  organization,
  projects,
  servers,
  services,
  sshKeys,
  stacks,
} from "@noddle/db/schema";
import { check, runVerify, suite } from "@noddle/testing";
import { devStack } from "@noddle/testing/dev-stack";
import { inArray } from "drizzle-orm";

import {
  environmentNameTaken,
  environmentsHold,
  listEnvVars,
  listProjectEnvironments,
  listProjects,
  projectNameTaken,
} from "@/lib/team-queries.server";

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
const [, envB] = await db
  .insert(environments)
  .values([
    { isDefault: true, name: "production", projectId: projectA?.id as string },
    { isDefault: true, name: "production", projectId: projectB?.id as string },
  ])
  .returning();

const [key] = await db
  .insert(sshKeys)
  .values({ name: `iso-key-${tag}`, privateKeyEncrypted: "not-a-real-key" })
  .returning();
const [server] = await db
  .insert(servers)
  .values({
    host: "192.0.2.1",
    name: `iso-server-${tag}`,
    sshKeyId: key?.id as string,
    sshUser: `noddle-${tag}`,
  })
  .returning();
const [serviceB] = await db
  .insert(services)
  .values({
    environmentId: envB?.id as string,
    name: `iso-svc-${tag}`,
    serverId: server?.id as string,
    sourceType: "docker_image",
  })
  .returning();
await db.insert(envVars).values({
  key: "DATABASE_PASSWORD",
  serviceId: serviceB?.id as string,
  valueEncrypted: "ciphertext-of-a-secret",
});
await db.insert(stacks).values({
  environmentId: envB?.id as string,
  gitRepoUrl: "https://example.invalid/repo.git",
  name: `iso-stack-${tag}`,
  serverId: server?.id as string,
  swarmName: `iso-stack-${tag}`,
});

const idsOf = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

await runVerify("team isolation", async () => {
  try {
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

    await suite(
      "a project reached by id is checked against the team",
      async () => {
        const ownEnvs = await listProjectEnvironments(
          db,
          teamA,
          projectA?.id as string
        );
        check("A lists its own project's environments", ownEnvs.length === 1);
        const foreignEnvs = await listProjectEnvironments(
          db,
          teamA,
          projectB?.id as string
        );
        check(
          "A passing B's project id gets nothing",
          foreignEnvs.length === 0,
          "the direct link to another team's project opened it"
        );
        check(
          "and B's environment names are not an oracle to A",
          !(await environmentNameTaken(
            db,
            teamA,
            projectB?.id as string,
            "production"
          ))
        );
      }
    );

    await suite("another team's secrets are out of reach", async () => {
      const ownRead = await listEnvVars(db, teamB, {
        serviceId: serviceB?.id as string,
      });
      check(
        "B reads its own service's variables",
        ownRead.some((row) => row.key === "DATABASE_PASSWORD"),
        "without a variable here the next check proves nothing"
      );
      const foreignRead = await listEnvVars(db, teamA, {
        serviceId: serviceB?.id as string,
      });
      check(
        "A passing B's service id reads none of its variables",
        foreignRead.length === 0,
        "A read another team's env vars, which are returned decrypted"
      );
    });

    await suite("a project name is not an oracle for other teams", async () => {
      const nameOfB = `proj-b-${tag}`;
      check(
        "B's name is taken inside B",
        await projectNameTaken(db, teamB, nameOfB)
      );
      check(
        "but A may use it, and learns nothing about B",
        !(await projectNameTaken(db, teamA, nameOfB)),
        "a global uniqueness check tells A that B has a project with this name"
      );
    });

    await suite(
      "resource checks cannot reach another team's environments",
      async () => {
        check(
          "B's environment really does hold a stack",
          await environmentsHold(db, teamB, [envB?.id as string]),
          "without a resource here the next check proves nothing"
        );
        check(
          "A asking about B's environment gets nothing back",
          !(await environmentsHold(db, teamA, [envB?.id as string])),
          "environmentsHold must filter the ids it is given by team"
        );
      }
    );
  } finally {
    await db
      .delete(envVars)
      .where(inArray(envVars.serviceId, [serviceB?.id as string]));
    await db
      .delete(services)
      .where(inArray(services.id, [serviceB?.id as string]));
    await db
      .delete(stacks)
      .where(inArray(stacks.environmentId, [envB?.id as string]));
    await db.delete(servers).where(inArray(servers.id, [server?.id as string]));
    await db.delete(sshKeys).where(inArray(sshKeys.id, [key?.id as string]));
    await db
      .delete(projects)
      .where(inArray(projects.id, [projectA?.id, projectB?.id] as string[]));
    await db
      .delete(organization)
      .where(inArray(organization.id, [teamA, teamB]));
  }
});
