// Bases de données en un clic : connecter, attacher à un service.
//
// « Attacher » n'affiche JAMAIS le mot de passe : la chaîne de connexion est
// construite et chiffrée entièrement côté serveur, puis écrite comme
// variable d'environnement du service choisi — le navigateur ne voit que
// « attaché », jamais la valeur. Contrairement à un secret de webhook, il
// n'y a ici aucun système tiers qui a besoin que l'utilisateur colle une
// valeur quelque part : l'attachement se fait de bout en bout côté serveur.
import { randomBytes } from "node:crypto";
import { databases, environments, envVars, projects } from "@noddle/db/schema";
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/shared/crypto";
import {
  attachDatabaseSchema,
  connectDatabaseSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

const PASSWORD_BYTES = 24;

export interface DatabaseRow {
  backupRetention: number;
  backupSchedule: "daily" | "off" | "weekly";
  engine: "postgres" | "redis";
  environment: string;
  id: string;
  name: string;
  project: string;
  serverName: string;
  status: string;
}

export const getDatabaseDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<DatabaseRow[]> => {
    await requireSession();
    const rows = await db.query.databases.findMany({
      orderBy: databases.name,
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
    return rows.map((d) => ({
      backupRetention: d.backupRetention,
      backupSchedule: d.backupSchedule,
      engine: d.engine,
      environment: d.environment.name,
      id: d.id,
      name: d.name,
      project: d.environment.project.name,
      serverName: d.server.name,
      status: d.status,
    }));
  }
);

export const connectDatabase = createServerFn({ method: "POST" })
  .validator(connectDatabaseSchema)
  .handler(async ({ data }): Promise<{ databaseId: string }> => {
    await requirePermission({ action: "create", resource: "database" });

    let project = await db.query.projects.findFirst({
      where: eq(projects.name, data.projectName),
    });
    if (!project) {
      const [created] = await db
        .insert(projects)
        .values({ name: data.projectName })
        .returning();
      if (!created) {
        throw new Error("could not create project");
      }
      project = created;
    }

    let environment = await db.query.environments.findFirst({
      where: and(
        eq(environments.projectId, project.id),
        eq(environments.name, data.environmentName)
      ),
    });
    if (!environment) {
      const [created] = await db
        .insert(environments)
        .values({ name: data.environmentName, projectId: project.id })
        .returning();
      if (!created) {
        throw new Error("could not create environment");
      }
      environment = created;
    }

    // Générée par Noddle, jamais saisie : uniquement hexadécimal, pour ne
    // jamais avoir à échapper un caractère de shell dans un healthcheck ou
    // une chaîne de connexion.
    const password = randomBytes(PASSWORD_BYTES).toString("hex");

    const [database] = await db
      .insert(databases)
      .values({
        engine: data.engine,
        environmentId: environment.id,
        name: data.name,
        rootPasswordEncrypted: "placeholder",
        rootUser: data.engine === "postgres" ? "noddle" : null,
        serverId: data.serverId,
      })
      .returning();
    if (!database) {
      throw new Error("could not create database");
    }

    // L'AAD lie le chiffré à la LIGNE : le mot de passe ne peut être chiffré
    // qu'une fois l'id connu.
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          password,
          env.appKey,
          secretContext.databasePassword(database.id)
        ),
      })
      .where(eq(databases.id, database.id));

    await enqueueDeploy({
      databaseId: database.id,
      kind: "provision-database",
    });
    return { databaseId: database.id };
  });

function connectionString(
  engine: "postgres" | "redis",
  host: string,
  password: string,
  rootUser: string | null
): string {
  if (engine === "postgres") {
    return `postgresql://${rootUser}:${password}@${host}:5432/${rootUser}`;
  }
  // `redis://:<mdp>@…` (utilisateur vide) échoue avec la plupart des clients
  // qui suivent le parseur d'URI de redis-cli : sans ACL, l'utilisateur
  // explicite `default` est nécessaire pour que le mot de passe soit
  // reconnu — mesuré contre une vraie instance (`verify-database.ts`).
  return `redis://default:${password}@${host}:6379`;
}

export const attachDatabase = createServerFn({ method: "POST" })
  .validator(attachDatabaseSchema)
  .handler(async ({ data }): Promise<{ key: string }> => {
    await requirePermission({ action: "attach", resource: "database" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }

    const password = decryptSecret(
      database.rootPasswordEncrypted,
      env.appKey,
      secretContext.databasePassword(database.id)
    );
    const host = `noddle-db-${database.name}`;
    const value = connectionString(
      database.engine,
      host,
      password,
      database.rootUser
    );

    const existing = await db.query.envVars.findFirst({
      where: and(
        eq(envVars.serviceId, data.serviceId),
        eq(envVars.key, data.envVarKey)
      ),
    });

    if (existing) {
      await db
        .update(envVars)
        .set({
          isSecret: true,
          updatedAt: new Date(),
          valueEncrypted: encryptSecret(
            value,
            env.appKey,
            secretContext.envVar(existing.id)
          ),
        })
        .where(eq(envVars.id, existing.id));
    } else {
      const id = crypto.randomUUID();
      await db.insert(envVars).values({
        id,
        isSecret: true,
        key: data.envVarKey,
        serviceId: data.serviceId,
        valueEncrypted: encryptSecret(
          value,
          env.appKey,
          secretContext.envVar(id)
        ),
      });
    }

    return { key: data.envVarKey };
  });
