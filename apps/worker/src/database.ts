// Base de données en un clic : un conteneur officiel, un volume nommé,
// épinglé au nœud qui le porte.
//
// Contrairement à `runDeploy`/`runStackDeploy`, il n'y a pas d'historique de
// versions ici — une base n'a qu'UNE image, jamais de build, jamais de
// rollback. `waitForRunningTask`/`readUpdateState`/`isDeployAccepted` sont
// réutilisés tels quels depuis `swarm.ts` : ce sont des sondages dockerode
// génériques, pas un mécanisme lié au chemin HTTP/Traefik des services.
import { databases } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { type DockerApi, disconnect, dockerClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { connectForDeploy, type DeployContext } from "#deploy";
import {
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  readUpdateState,
  waitForRunningTask,
} from "#swarm";

type Engine = "postgres" | "redis";

interface EngineSpec {
  command?: (password: string) => string[];
  env: (rootUser: string | null, password: string) => string[];
  healthcheck: (password: string, rootUser: string | null) => string[];
  image: string;
  port: number;
  volumePath: string;
}

const SECOND_NS = 1_000_000_000;

/**
 * Générées par Noddle, jamais choisies par l'utilisateur : uniquement
 * hexadécimal, pour ne jamais avoir à échapper un caractère de shell dans un
 * healthcheck ou une chaîne de connexion.
 */
const ENGINE_SPECS: Record<Engine, EngineSpec> = {
  postgres: {
    env: (rootUser, password) => [
      `POSTGRES_USER=${rootUser}`,
      `POSTGRES_PASSWORD=${password}`,
      `POSTGRES_DB=${rootUser}`,
    ],
    // pg_isready est fourni par l'image officielle — même famille de piège
    // que curl/nixpacks : le binaire doit être DANS l'image, jamais supposé.
    healthcheck: (_password, rootUser) => [
      "CMD-SHELL",
      `pg_isready -U ${rootUser} || exit 1`,
    ],
    image: "postgres:17-alpine",
    port: 5432,
    volumePath: "/var/lib/postgresql/data",
  },
  redis: {
    command: (password) => [
      "redis-server",
      "--requirepass",
      password,
      "--appendonly",
      "yes",
    ],
    env: () => [],
    healthcheck: (password) => [
      "CMD-SHELL",
      `redis-cli -a ${password} ping || exit 1`,
    ],
    image: "redis:7-alpine",
    port: 6379,
    volumePath: "/data",
  },
};

async function ensureVolume(docker: DockerApi, name: string): Promise<void> {
  const list = (await docker.listVolumes()) as unknown as {
    Volumes?: Array<{ Name?: string }>;
  };
  if (list.Volumes?.some((v) => v.Name === name)) {
    return;
  }
  await docker.createVolume({ Name: name });
}

async function findServiceByName(docker: DockerApi, name: string) {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [name] }),
  });
  // Filtre par PRÉFIXE côté Docker — déjà noté dans swarm.ts.
  return list.find((s) => s.Spec?.Name === name) ?? null;
}

/**
 * Renvoyée par une fonction plutôt qu'écrite en littéral au point d'appel :
 * les types de service dockerode se contredisent eux-mêmes entre le chemin
 * conteneur seul (`Healthcheck`) et celui d'un service Swarm (`HealthCheck`
 * dans certaines de leurs déclarations) — passer par une valeur évite que le
 * contrôle des propriétés en excès d'un littéral ne bute dessus, exactement
 * comme `serviceSpec()` dans `swarm.ts`.
 */
function databaseServiceSpec(opts: {
  name: string;
  networkName: string;
  password: string;
  placementNodeId?: string;
  rootUser: string | null;
  spec: EngineSpec;
}) {
  const { name, networkName, password, placementNodeId, rootUser, spec } = opts;
  return {
    Labels: { "traefik.enable": "false" },
    Mode: { Replicated: { Replicas: 1 } },
    Name: name,
    Networks: [{ Target: networkName }],
    TaskTemplate: {
      ...(placementNodeId
        ? { Placement: { Constraints: [`node.id==${placementNodeId}`] } }
        : {}),
      ContainerSpec: {
        ...(spec.command ? { Command: spec.command(password) } : {}),
        Env: spec.env(rootUser, password),
        Healthcheck: {
          Interval: 3 * SECOND_NS,
          Retries: 5,
          StartPeriod: 5 * SECOND_NS,
          Test: spec.healthcheck(password, rootUser),
          Timeout: 3 * SECOND_NS,
        },
        Image: spec.image,
        Mounts: [
          { Source: name, Target: spec.volumePath, Type: "volume" as const },
        ],
      },
      Networks: [{ Target: networkName }],
      RestartPolicy: {
        Condition: "on-failure",
        MaxAttempts: 3,
        Window: 120 * SECOND_NS,
      },
    },
  };
}

export async function provisionDatabase(
  ctx: DeployContext,
  databaseId: string
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
  if (!database) {
    throw new Error(`base de données introuvable : ${databaseId}`);
  }

  const spec = ENGINE_SPECS[database.engine];
  const password = decryptSecret(
    database.rootPasswordEncrypted,
    ctx.appKey,
    secretContext.databasePassword(database.id)
  );

  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    database.server
  );

  try {
    const buildDocker = dockerClient(buildClient);
    const name = `noddle-db-${database.name}`;

    // Le volume est LOCAL au nœud qui l'héberge : créé sur SA connexion,
    // jamais via le manager quand les deux diffèrent.
    await ensureVolume(buildDocker, name);

    // TOUJOURS épinglée, sans condition. Une base est le cas où la contrainte
    // compte le PLUS : son volume nommé n'existe que sur ce nœud, et Swarm ne
    // résout pas le stockage distribué. Sans contrainte, un cluster à
    // plusieurs nœuds peut planifier la base ailleurs — où elle démarrerait
    // sur un volume VIDE, sans erreur, avec l'air de fonctionner.
    //
    // Le code d'avant la sautait quand la base était hébergée par le manager
    // (`sameConnection`), en la croyant sans effet : ce n'est vrai que sur un
    // cluster à un seul nœud. Même trou que dans `deploy.ts` et `compose.ts`,
    // et c'est ici qu'il coûterait le plus cher.
    const placementNodeId =
      database.server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));
    const managerDocker = sameConnection
      ? buildDocker
      : dockerClient(managerClient);
    await ensureOverlayNetwork(managerDocker, ctx.networkName);

    const existing = await findServiceByName(managerDocker, name);
    if (!existing) {
      await managerDocker.createService(
        databaseServiceSpec({
          name,
          networkName: ctx.networkName,
          password,
          placementNodeId,
          rootUser: database.rootUser,
          spec,
        })
      );
      // Une CRÉATION n'a pas d'UpdateStatus — sans attendre la task, un
      // premier démarrage cassé se lirait comme un succès.
      await waitForRunningTask(managerDocker, name);
    }

    const state = await readUpdateState(managerDocker, name);
    const accepted = isDeployAccepted(state.updateState);
    await ctx.db
      .update(databases)
      .set({ status: accepted ? "running" : "crashed" })
      .where(eq(databases.id, database.id));
  } catch (err) {
    await ctx.db
      .update(databases)
      .set({ status: "crashed" })
      .where(eq(databases.id, database.id));
    throw err;
  } finally {
    if (managerClient !== buildClient) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
}
