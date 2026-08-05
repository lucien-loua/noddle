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
  exec,
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

  // Le VOLUME, pas seulement le service : un volume nommé SURVIT à
  // `removeService`. Sans ça, la seconde exécution provisionne une base avec
  // un mot de passe NEUF sur un répertoire de données EXISTANT — or Postgres
  // n'applique `POSTGRES_PASSWORD` qu'à la première initialisation. Le test
  // échouait alors sur « password authentication failed » en accusant le code,
  // alors que la faute était à son propre décor. Même piège que celui déjà
  // relevé pour `verify-backup.ts`.
  //
  // Une boucle de tentatives : le volume peut rester verrouillé quelques
  // instants par le conteneur qu'on vient de retirer.
  for (const name of ["noddle-db-probe-postgres", "noddle-db-probe-redis"]) {
    for (let i = 0; i < 10; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: réessai volontaire
      const res = await execArgv(managerSsh, [
        "sudo",
        "docker",
        "volume",
        "rm",
        name,
      ]);
      if (res.code === 0 || res.stderr.includes("no such volume")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

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

  // ── la contrainte de placement : le test qui manquait ────────────────
  //
  // Une base est le cas où elle compte le PLUS. Son volume nommé n'existe que
  // sur SON nœud, et Swarm ne résout pas le stockage distribué : sans
  // contrainte, un cluster à plusieurs nœuds peut la planifier ailleurs, où
  // elle démarrerait sur un volume VIDE — sans erreur, avec l'air de marcher.
  //
  // Le code d'avant sautait la contrainte quand la base était hébergée par le
  // manager, en la croyant sans effet : vrai sur un nœud, faux dès le second.
  // Rien ici ne le voyait, puisque ce test n'inspectait que la santé.
  const nodeId = (
    await exec(managerSsh, "sudo docker info --format '{{.Swarm.NodeID}}'")
  ).stdout.trim();
  const managerDocker = dockerClient(managerSsh);
  for (const name of ["noddle-db-probe-postgres", "noddle-db-probe-redis"]) {
    // biome-ignore lint/performance/noAwaitInLoops: deux services, séquentiel volontaire
    const list = (await managerDocker.listServices({
      filters: JSON.stringify({ name: [name] }),
    })) as unknown as {
      Spec?: {
        Name?: string;
        TaskTemplate?: { Placement?: { Constraints?: string[] } };
      };
    }[];
    const found = list.find((s) => s.Spec?.Name === name);
    const constraints = found?.Spec?.TaskTemplate?.Placement?.Constraints ?? [];
    if (constraints.includes(`node.id==${nodeId}`)) {
      ok(`${name} est épinglée à son nœud — son volume ne voyage pas`);
    } else {
      ko(
        `${name} sans contrainte : [${constraints.join(", ")}] — Swarm pourrait la déplacer sur un volume vide`
      );
    }
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
