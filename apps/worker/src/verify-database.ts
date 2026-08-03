// Base de données en un clic, contre une vraie VM.
//
// La question qui compte n'est pas « le conteneur démarre-t-il ? » mais
// « un AUTRE conteneur peut-il vraiment s'y connecter avec les identifiants
// générés ? » — c'est exactement ce que fait « Attacher à un service » côté
// web, donc c'est ce que ce test reproduit : un `docker run` jetable, sur le
// MÊME réseau overlay, qui s'authentifie pour de vrai.
//
//   STACK_HOST=192.168.252.3 DATABASE_URL=… node apps/worker/src/verify-database.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@noddle/db";
import { databases, environments, projects, servers } from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { eq, inArray } from "drizzle-orm";
import { provisionDatabase } from "#database";
import { removeService } from "#swarm";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [HOST]));

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "database-probe-manager",
      role: "manager",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("insertion serveur échouée");
  }
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(server.id)
      ),
    })
    .where(eq(servers.id, server.id));
  ok("serveur enregistré");

  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-database-logs",
    networkName: "noddle-public",
  };

  managerSsh = await connect({ host: HOST, privateKey, user: USER });
  await removeService(dockerClient(managerSsh), "noddle-db-probe-postgres");
  await removeService(dockerClient(managerSsh), "noddle-db-probe-redis");

  const [proj] = await db
    .insert(projects)
    .values({ name: "database-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  const httpRun = async (
    image: string,
    args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    if (!managerSsh) {
      throw new Error("pas de connexion manager");
    }
    return await execArgv(managerSsh, [
      "sudo",
      "docker",
      "run",
      "--rm",
      "--network",
      "noddle-public",
      image,
      ...args,
    ]);
  };

  // ── Postgres ───────────────────────────────────────────────────────────
  {
    const password = randomBytes(24).toString("hex");
    const [database] = await db
      .insert(databases)
      .values({
        engine: "postgres",
        environmentId: env?.id ?? "",
        name: "probe-postgres",
        rootPasswordEncrypted: "placeholder",
        rootUser: "noddle",
        serverId: server.id,
      })
      .returning();
    if (!database) {
      throw new Error("insertion base postgres échouée");
    }
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          password,
          appKey,
          secretContext.databasePassword(database.id)
        ),
      })
      .where(eq(databases.id, database.id));

    console.log("    (provisionnement de postgres…)");
    await provisionDatabase(ctx, database.id);

    const row = await db.query.databases.findFirst({
      where: eq(databases.id, database.id),
    });
    if (row?.status === "running") {
      ok("postgres provisionné et sain");
    } else {
      ko(`postgres : statut ${row?.status}`);
    }

    const url = `postgresql://noddle:${password}@noddle-db-probe-postgres:5432/noddle`;
    const result = await httpRun("postgres:17-alpine", [
      "psql",
      url,
      "-c",
      "select 1",
    ]);
    if (result.code === 0 && result.stdout.includes("1")) {
      ok("un AUTRE conteneur s'est authentifié et a requêté postgres");
    } else {
      ko(
        `connexion postgres échouée (code ${result.code}) : ${result.stderr.slice(0, 200)}`
      );
    }
  }

  // ── Redis ──────────────────────────────────────────────────────────────
  {
    const password = randomBytes(24).toString("hex");
    const [database] = await db
      .insert(databases)
      .values({
        engine: "redis",
        environmentId: env?.id ?? "",
        name: "probe-redis",
        rootPasswordEncrypted: "placeholder",
        serverId: server.id,
      })
      .returning();
    if (!database) {
      throw new Error("insertion base redis échouée");
    }
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          password,
          appKey,
          secretContext.databasePassword(database.id)
        ),
      })
      .where(eq(databases.id, database.id));

    console.log("    (provisionnement de redis…)");
    await provisionDatabase(ctx, database.id);

    const row = await db.query.databases.findFirst({
      where: eq(databases.id, database.id),
    });
    if (row?.status === "running") {
      ok("redis provisionné et sain");
    } else {
      ko(`redis : statut ${row?.status}`);
    }

    // `redis://:<mdp>@…` (utilisateur vide) échoue avec redis-cli : sans ACL,
    // le parseur d'URI a besoin de l'utilisateur explicite `default` pour
    // extraire correctement le mot de passe — mesuré, "AUTH failed" sinon
    // alors que le MÊME mot de passe passé en `-a` fonctionne.
    const url = `redis://default:${password}@noddle-db-probe-redis:6379`;
    const result = await httpRun("redis:7-alpine", [
      "redis-cli",
      "-u",
      url,
      "ping",
    ]);
    if (result.code === 0 && result.stdout.includes("PONG")) {
      ok("un AUTRE conteneur s'est authentifié et a interrogé redis");
    } else {
      ko(
        `connexion redis échouée (code ${result.code}) : ${result.stderr.slice(0, 200)}`
      );
    }
  }

  // ── idempotence : rejouer le provisionnement ne casse rien ────────────
  const again = await db.query.databases.findFirst({
    where: eq(databases.name, "probe-postgres"),
  });
  if (again) {
    await provisionDatabase(
      {
        appKey,
        db,
        logRoot: "/tmp/noddle-database-logs",
        networkName: "noddle-public",
      },
      again.id
    );
    ok("second provisionnement rejouable sans erreur (idempotent)");
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (managerSsh) {
    try {
      const docker = dockerClient(managerSsh);
      if (!process.env.NODDLE_KEEP) {
        await removeService(docker, "noddle-db-probe-postgres");
        await removeService(docker, "noddle-db-probe-redis");
        await execArgv(managerSsh, [
          "sudo",
          "docker",
          "volume",
          "rm",
          "-f",
          "noddle-db-probe-postgres",
          "noddle-db-probe-redis",
        ]);
      }
    } catch {
      // nettoyage au mieux
    }
    disconnect(managerSsh);
  }
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
