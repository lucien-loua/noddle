// tier: local
import { randomBytes } from "node:crypto";

import { createDatabase } from "@noddle/db";
import {
  databaseDeployments,
  databases,
  deployments,
  envVars,
  environments,
  organization,
  projects,
  servers,
  services,
  sshKeys,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { check, runVerify, suite } from "@noddle/testing";
import { devStack } from "@noddle/testing/dev-stack";
import { inArray } from "drizzle-orm";

import {
  databaseDeploymentsOf,
  databaseInContext,
  environmentNameTaken,
  environmentOfProject,
  environmentsHold,
  listDatabasesInContext,
  listEnvVars,
  listProjectEnvironments,
  listProjects,
  listServicesInContext,
  listStacksInContext,
  projectNameTaken,
  recentServiceDeployments,
  recentStackDeployments,
  serviceDeploymentsOf,
  serviceInContext,
  stackDeploymentsOf,
  teamActivityCounts,
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
const [stackB] = await db
  .insert(stacks)
  .values({
    environmentId: envB?.id as string,
    gitRepoUrl: "https://example.invalid/repo.git",
    name: `iso-stack-${tag}`,
    serverId: server?.id as string,
    swarmName: `iso-stack-${tag}`,
  })
  .returning();
const [databaseB] = await db
  .insert(databases)
  .values({
    engine: "postgres",
    environmentId: envB?.id as string,
    name: `iso-db-${tag}`,
    rootPasswordEncrypted: "not-a-real-password",
    serverId: server?.id as string,
    swarmName: `iso-db-${tag}`,
  })
  .returning();
const [deploymentB] = await db
  .insert(deployments)
  .values({ serviceId: serviceB?.id as string })
  .returning();
const [stackDeploymentB] = await db
  .insert(stackDeployments)
  .values({ stackId: stackB?.id as string })
  .returning();
await db
  .insert(databaseDeployments)
  .values({ databaseId: databaseB?.id as string });

const B = {
  database: databaseB?.id as string,
  deployment: deploymentB?.id as string,
  environment: envB?.id as string,
  project: projectB?.id as string,
  service: serviceB?.id as string,
  stack: stackB?.id as string,
  stackDeployment: stackDeploymentB?.id as string,
};
const RECENT = 200;
const SINCE_EPOCH = new Date(0);

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

    await suite("the dashboard lists only the team's resources", async () => {
      const [servicesOfB, stacksOfB, databasesOfB] = await Promise.all([
        listServicesInContext(db, teamB),
        listStacksInContext(db, teamB),
        listDatabasesInContext(db, teamB),
      ]);
      check(
        "B's dashboard holds its service, stack and database",
        idsOf(servicesOfB).has(B.service) &&
          idsOf(stacksOfB).has(B.stack) &&
          idsOf(databasesOfB).has(B.database),
        "without them here the checks below prove nothing"
      );

      const [servicesOfA, stacksOfA, databasesOfA] = await Promise.all([
        listServicesInContext(db, teamA),
        listStacksInContext(db, teamA),
        listDatabasesInContext(db, teamA),
      ]);
      check(
        "A's dashboard shows none of B's services",
        !idsOf(servicesOfA).has(B.service),
        "getDashboard and getDashboardGroups list every team's services"
      );
      check(
        "nor B's stacks",
        !idsOf(stacksOfA).has(B.stack),
        "getStackDashboard lists every team's stacks"
      );
      check(
        "nor B's databases",
        !idsOf(databasesOfA).has(B.database),
        "getDatabaseDashboard lists every team's databases"
      );

      const throughForeignEnvironment = await Promise.all([
        listServicesInContext(db, teamA, B.environment),
        listStacksInContext(db, teamA, B.environment),
        listDatabasesInContext(db, teamA, B.environment),
      ]);
      check(
        "A passing B's environment id gets an empty scope",
        throughForeignEnvironment.every((rows) => rows.length === 0),
        "getEnvironmentScope filled from another team's environment"
      );
    });

    await suite(
      "a resource reached by id is checked against the team",
      async () => {
        check(
          "B opens its own service, database and environment",
          (await serviceInContext(db, teamB, B.service)) !== undefined &&
            (await databaseInContext(db, teamB, B.database)) !== undefined &&
            (await environmentOfProject(
              db,
              teamB,
              B.project,
              B.environment
            )) !== undefined
        );
        check(
          "A passing B's service id gets nothing",
          (await serviceInContext(db, teamA, B.service)) === undefined,
          "getService returns another team's service, domains and server"
        );
        check(
          "A passing B's database id gets nothing",
          (await databaseInContext(db, teamA, B.database)) === undefined,
          "getDatabase returns another team's database"
        );
        check(
          "A passing B's project and environment ids gets nothing",
          (await environmentOfProject(db, teamA, B.project, B.environment)) ===
            undefined,
          "getEnvironmentScope opens another team's environment"
        );
      }
    );

    await suite("deployment history stays inside the team", async () => {
      const [ownService, ownStack, ownDatabase] = await Promise.all([
        serviceDeploymentsOf(db, teamB, [B.service]),
        stackDeploymentsOf(db, teamB, [B.stack]),
        databaseDeploymentsOf(db, teamB, B.database, RECENT),
      ]);
      check(
        "B sees its service, stack and database deployments",
        ownService.length === 1 &&
          ownStack.length === 1 &&
          ownDatabase.length === 1,
        "without them here the checks below prove nothing"
      );
      check(
        "A passing B's service id reads none of its deployments",
        (await serviceDeploymentsOf(db, teamA, [B.service])).length === 0,
        "getDeployments returns another team's history"
      );
      check(
        "A passing B's stack id reads none of its deployments",
        (await stackDeploymentsOf(db, teamA, [B.stack])).length === 0
      );
      check(
        "A passing B's database id reads none of its deployments",
        (await databaseDeploymentsOf(db, teamA, B.database, RECENT)).length ===
          0,
        "getDatabaseDeployments returns another team's history"
      );

      const [recentOfA, recentOfB] = await Promise.all([
        recentServiceDeployments(db, teamA, RECENT),
        recentServiceDeployments(db, teamB, RECENT),
      ]);
      check(
        "B's deployment is in B's recent activity",
        idsOf(recentOfB).has(B.deployment)
      );
      check(
        "and not in A's",
        !idsOf(recentOfA).has(B.deployment),
        "the deployment log and the overview show every team's deploys"
      );
      const [stackRecentOfA, stackRecentOfB] = await Promise.all([
        recentStackDeployments(db, teamA, RECENT),
        recentStackDeployments(db, teamB, RECENT),
      ]);
      check(
        "B's stack deployment is in B's log and not in A's",
        idsOf(stackRecentOfB).has(B.stackDeployment) &&
          !idsOf(stackRecentOfA).has(B.stackDeployment),
        "the deployment log shows every team's stack deploys"
      );
    });

    await suite("the overview counts only the team", async () => {
      const ofA = await teamActivityCounts(db, teamA, SINCE_EPOCH);
      const ofB = await teamActivityCounts(db, teamB, SINCE_EPOCH);
      check(
        "B counts its deployment",
        ofB.deploys === 1,
        `${ofB.deploys} deploys`
      );
      check(
        "A counts exactly its own project, environment and no deploy",
        ofA.projects === 1 && ofA.environments === 1 && ofA.deploys === 0,
        `${ofA.projects} projects, ${ofA.environments} environments, ${ofA.deploys} deploys`
      );
    });
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
    await db
      .delete(databases)
      .where(inArray(databases.environmentId, [envB?.id as string]));
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
