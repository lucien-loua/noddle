// Déploiement Docker Compose : plusieurs conteneurs sous un même nom, posés
// par `docker stack deploy` — jamais une boucle de `docker service create`
// maison. Voir `packages/db/src/schema/stacks.ts` pour le pourquoi.
//
// La chaîne, par étape :
//
//   fetchSource → lire le fichier compose → construire chaque service avec un
//   `build:` (Dockerfile fourni par l'utilisateur, capped-builder partagé
//   avec le chemin nixpacks) → réécrire `build:` en `image:` → injecter
//   placement/health-gate/labels → écrire le fichier réécrit sur le MANAGER
//   → `docker stack deploy` → relire l'état de CHAQUE service résultant,
//   exactement comme le chemin mono-service, parce que `docker stack deploy`
//   rend la main avant convergence tout comme `docker service update`.
import { randomUUID } from "node:crypto";
import {
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "@noddle/build-engine";
import type { Database } from "@noddle/db";
import {
  stackDeploymentLogs,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { routeLabels } from "@noddle/proxy-config";
import {
  disconnect,
  dockerClient,
  execArgv,
  type SshClient,
  writeRemoteFile,
} from "@noddle/ssh-executor";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { BUILD_ROOT, connectForDeploy, type DeployContext } from "#deploy";
import { createLogSink } from "#log-sink";
import {
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  readUpdateState,
  UPDATE_MONITOR_SECONDS,
  waitForRunningTask,
} from "#swarm";
import { watchUntilFor } from "#watch";

// ─────────────────────────────────────────────────────────────────────────────
// Le fichier compose, juste assez typé pour ce qu'on lit et réécrit
// ─────────────────────────────────────────────────────────────────────────────

interface ComposeBuildSpec {
  context?: string;
  dockerfile?: string;
}

interface ComposeService {
  build?: ComposeBuildSpec | string;
  deploy?: Record<string, unknown>;
  healthcheck?: unknown;
  image?: string;
  networks?: Record<string, unknown> | string[];
  [key: string]: unknown;
}

interface ComposeFile {
  networks?: Record<string, unknown>;
  services?: Record<string, ComposeService>;
  [key: string]: unknown;
}

/**
 * Clé compose acceptée telle quelle dans un nom de service Swarm
 * (`${stackName}_${clé}`) et dans un tag d'image. Un fichier compose vient de
 * l'utilisateur : jamais une constante du code, même prudence qu'à l'entrée
 * de `fetchSource`.
 */
const SAFE_COMPOSE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Chemin de fichier relatif, sans évasion du répertoire cloné. */
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

function parseCompose(text: string, path: string): ComposeFile {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid compose file (${path}): ${message}`, {
      cause: err,
    });
  }
  if (typeof doc !== "object" || doc === null || !("services" in doc)) {
    throw new Error(`compose file has no "services" section (${path})`);
  }
  return doc as ComposeFile;
}

/**
 * Les clés de service d'un `stack_deployments.compose_source` stocké —
 * utilisée par `sweep.ts` pour savoir QUELS services Swarm inspecter, sans
 * dupliquer le parsing ici.
 */
export function listComposeServiceKeys(composeSource: string): string[] {
  const doc = parseCompose(composeSource, "(stocké)");
  return Object.keys(doc.services ?? {});
}

/**
 * N'importe quel déploiement de pile encore « sous surveillance » cesse de
 * l'être dès qu'un AUTRE déploiement devient le courant — même raison que
 * `clearSupersededWatch` dans `deploy.ts` : `inspectServiceHealth` vérifie un
 * nom de service Swarm, pas quel déploiement a produit quelle task, et une
 * pile antérieure pourtant saine se ferait sinon accuser du crash d'une
 * pile plus récente.
 */
async function clearSupersededStackWatch(
  db: Database,
  stackId: string,
  currentDeploymentId: string
): Promise<void> {
  await db
    .update(stackDeployments)
    .set({ watchUntil: null })
    .where(
      and(
        eq(stackDeployments.stackId, stackId),
        ne(stackDeployments.id, currentDeploymentId),
        isNotNull(stackDeployments.watchUntil)
      )
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection : placement, health-gate, route Traefik
// ─────────────────────────────────────────────────────────────────────────────

interface InjectOptions {
  builtKeys: readonly string[];
  certResolver?: string;
  domain?: string | null;
  networkName: string;
  placementNodeId?: string;
  port?: number | null;
  publicService?: string | null;
  stackName: string;
}

/**
 * Même garantie que `serviceSpec()` en Phase 1, exprimée en YAML plutôt qu'en
 * objet dockerode : `docker stack deploy` traduit `deploy.update_config` /
 * `deploy.rollback_config` en la même API Swarm. Appliquée à CHAQUE service
 * que Noddle construit — pas seulement le public — parce que la bascule
 * saine sans coupure est la garantie que Noddle vend, pas un privilège du
 * seul service exposé.
 */
function injectDeployConfig(doc: ComposeFile, opts: InjectOptions): void {
  const services = doc.services ?? {};

  for (const key of opts.builtKeys) {
    const svc = services[key];
    if (!svc) {
      continue;
    }
    const deploy = { ...(svc.deploy ?? {}) } as Record<string, unknown>;

    if (opts.placementNodeId) {
      deploy.placement = {
        constraints: [`node.id==${opts.placementNodeId}`],
      };
    }
    deploy.update_config = {
      failure_action: "rollback",
      max_failure_ratio: 0,
      monitor: `${UPDATE_MONITOR_SECONDS}s`,
      order: "start-first",
      parallelism: 1,
    };
    // `pause`, pas `rollback` : un rollback qui échoue ne doit pas en
    // déclencher un autre — même raison que le chemin mono-service.
    deploy.rollback_config = {
      failure_action: "pause",
      max_failure_ratio: 0,
      monitor: `${UPDATE_MONITOR_SECONDS}s`,
      order: "start-first",
      parallelism: 1,
    };
    deploy.restart_policy = {
      condition: "on-failure",
      max_attempts: 3,
      window: "120s",
    };
    svc.deploy = deploy;
  }

  if (!(opts.publicService && opts.port !== null && opts.port !== undefined)) {
    return;
  }
  const pub = services[opts.publicService];
  if (!pub) {
    return;
  }

  const swarmName = `${opts.stackName}_${opts.publicService}`;
  const deploy = { ...(pub.deploy ?? {}) } as Record<string, unknown>;
  deploy.labels = routeLabels({
    certResolver: opts.certResolver,
    domain: opts.domain ?? undefined,
    port: opts.port,
    serviceName: swarmName,
  });
  pub.deploy = deploy;

  // curl est présent dans l'image de base nixpacks et dans la plupart des
  // images Node/Python ; wget non et node n'est pas sur le PATH d'un shell
  // non-login — même piège que `serviceSpec()`. On ne l'injecte QUE si
  // l'utilisateur n'a pas déjà son propre healthcheck : le sien prime.
  if (!pub.healthcheck) {
    pub.healthcheck = {
      interval: "3s",
      retries: 3,
      start_period: "5s",
      test: [
        "CMD-SHELL",
        `curl -fsS -o /dev/null http://127.0.0.1:${opts.port}/ || exit 1`,
      ],
      timeout: "2s",
    };
  }

  // Le service public doit joindre le réseau overlay que Traefik écoute, EN
  // PLUS du réseau interne de la pile — les autres conteneurs de la pile ont
  // besoin de continuer à se joindre entre eux normalement.
  doc.networks = {
    ...(doc.networks ?? {}),
    [opts.networkName]: { external: true },
  };
  if (Array.isArray(pub.networks)) {
    if (!pub.networks.includes(opts.networkName)) {
      pub.networks = [...pub.networks, opts.networkName];
    }
  } else if (pub.networks && typeof pub.networks === "object") {
    pub.networks = { ...pub.networks, [opts.networkName]: null };
  } else {
    pub.networks = [opts.networkName];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Écriture + `docker stack deploy` + relecture par service
// ─────────────────────────────────────────────────────────────────────────────

interface DeployStackResult {
  accepted: boolean;
  swarmUpdateStates: Record<string, string | null>;
}

/**
 * `docker stack deploy` rend la main dès que Swarm a accepté les specs, PAS
 * quand les tasks convergent — exactement `docker service update`, en pire :
 * un seul code de sortie pour N services. On relit donc chacun séparément,
 * avec le même sondage que le chemin mono-service (`waitForRunningTask` sur
 * une création, `readUpdateState` toujours).
 */
async function writeAndDeployStack(
  ctx: DeployContext,
  opts: {
    doc: ComposeFile;
    managerClient: SshClient;
    stackName: string;
    stream?: { onStderr: (s: string) => void; onStdout: (s: string) => void };
  }
): Promise<DeployStackResult> {
  const { managerClient, stackName, doc } = opts;
  const stream = opts.stream ?? {
    onStderr: () => undefined,
    onStdout: () => undefined,
  };
  const managerDocker = dockerClient(managerClient);
  await ensureOverlayNetwork(managerDocker, ctx.networkName);

  const serviceKeys = Object.keys(doc.services ?? {});

  // Filtre Docker par PRÉFIXE (déjà noté dans swarm.ts) : suffisant ici, un
  // nom de pile est unique par construction (index unique en base).
  const existingList = await managerDocker.listServices({
    filters: JSON.stringify({ name: [stackName] }),
  });
  const existing = new Set(
    existingList.map((s) => s.Spec?.Name).filter((n): n is string => Boolean(n))
  );

  const tmpPath = `/tmp/noddle-stack-${randomUUID()}.yml`;
  await writeRemoteFile(managerClient, tmpPath, stringifyYaml(doc));

  try {
    const result = await execArgv(
      managerClient,
      [
        "sudo",
        "docker",
        "stack",
        "deploy",
        "--resolve-image",
        "never",
        "-c",
        tmpPath,
        stackName,
      ],
      stream
    );
    if (result.code !== 0) {
      throw new Error(
        `docker stack deploy a échoué (code ${result.code})\n${(result.stderr || result.stdout).trim()}`
      );
    }

    const swarmUpdateStates: Record<string, string | null> = {};
    let accepted = true;
    for (const key of serviceKeys) {
      const swarmName = `${stackName}_${key}`;
      if (!existing.has(swarmName)) {
        // biome-ignore lint/performance/noAwaitInLoops: sondages séquentiels, un service après l'autre — paralléliser mélangerait les logs de convergence de services indépendants
        await waitForRunningTask(managerDocker, swarmName);
      }
      const state = await readUpdateState(managerDocker, swarmName);
      swarmUpdateStates[key] = state.updateState;
      if (!isDeployAccepted(state.updateState)) {
        accepted = false;
      }
    }
    return { accepted, swarmUpdateStates };
  } finally {
    await execArgv(managerClient, ["rm", "-f", tmpPath]).catch(() => undefined);
  }
}

/**
 * Construit, un par un, chaque service compose qui déclare un `build:` — sur
 * le MÊME builder capé que le chemin nixpacks, jamais en parallèle : le
 * plafond mémoire protège la machine, pas chaque build individuellement.
 * Réécrit `services` EN PLACE, `build:` remplacé par le tag construit.
 */
async function buildComposeServices(opts: {
  buildClient: SshClient;
  onServiceStart: (key: string) => void;
  services: Record<string, ComposeService>;
  sha: string;
  stackName: string;
  stream: { onStderr: (s: string) => void; onStdout: (s: string) => void };
  workDir: string;
}): Promise<Record<string, string>> {
  const serviceImages: Record<string, string> = {};

  for (const [key, svc] of Object.entries(opts.services)) {
    if (!SAFE_COMPOSE_KEY.test(key)) {
      throw new Error(`compose service name refused: ${JSON.stringify(key)}`);
    }
    if (!svc.build) {
      continue;
    }
    const buildSpec: ComposeBuildSpec =
      typeof svc.build === "string" ? { context: svc.build } : svc.build;
    const contextDir = `${opts.workDir}/${buildSpec.context ?? "."}`;
    const dockerfilePath = buildSpec.dockerfile ?? "Dockerfile";
    const imageTag = `${opts.stackName}-${key}:${opts.sha.slice(0, 12)}-${Date.now()}`;

    opts.onServiceStart(key);
    // biome-ignore lint/performance/noAwaitInLoops: builds séquentiels sur le MÊME builder capé — les paralléliser dépasserait le plafond mémoire qu'il existe pour appliquer
    await buildImageFromDockerfile(opts.buildClient, {
      builderName: "noddle-builder",
      contextDir,
      dockerfilePath,
      imageTag,
      ...opts.stream,
    });

    serviceImages[key] = imageTag;
    // Reconstruit l'objet plutôt que `delete svc.build` : la sérialisation
    // YAML d'une clé mise à `undefined` n'est pas garantie équivalente à son
    // absence, et `docker stack deploy` verrait alors un `build:` vide au
    // lieu de rien.
    const { build: _build, ...rest } = svc;
    opts.services[key] = { ...rest, image: imageTag };
  }

  return serviceImages;
}

// ─────────────────────────────────────────────────────────────────────────────
// Déploiement complet : clone, build, bascule
// ─────────────────────────────────────────────────────────────────────────────

export async function runStackDeploy(
  ctx: DeployContext,
  data: { stackDeploymentId: string }
): Promise<void> {
  const { db } = ctx;

  const deployment = await db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, data.stackDeploymentId),
    with: { stack: { with: { server: true } } },
  });
  if (!deployment) {
    throw new Error(
      `déploiement de pile introuvable : ${data.stackDeploymentId}`
    );
  }

  const { stack } = deployment;
  const { server } = stack;
  const startedAt = new Date();

  if (!SAFE_RELATIVE_PATH.test(stack.composeFilePath)) {
    throw new Error(
      `chemin de fichier compose refusé : ${JSON.stringify(stack.composeFilePath)}`
    );
  }

  await db
    .update(stackDeployments)
    .set({ startedAt, status: "building" })
    .where(eq(stackDeployments.id, deployment.id));

  const sink = await createLogSink({
    deploymentId: deployment.id,
    onChunk: (c) => ctx.onLog?.(deployment.id, c),
    root: ctx.logRoot,
  });
  const stream = { onStderr: sink.write, onStdout: sink.write };

  let buildClient: SshClient | undefined;
  let managerClient: SshClient | undefined;

  try {
    ({ buildClient, managerClient } = await connectForDeploy(ctx, server));

    const cap = computeBuildCap({
      totalMemoryMb: server.totalMemoryMb ?? 2048,
    });
    sink.write(`▸ build capped at ${cap.memory}\n`);
    await ensureCappedBuilder(buildClient, "noddle-builder", cap, stream);

    const workDir = `${BUILD_ROOT}/stacks/${stack.id}`;
    const sha = await fetchSource(buildClient, {
      branch: stack.gitBranch,
      commitSha: deployment.commitSha ?? undefined,
      dir: workDir,
      repoUrl: stack.gitRepoUrl,
      ...stream,
    });
    await db
      .update(stackDeployments)
      .set({ commitSha: sha })
      .where(eq(stackDeployments.id, deployment.id));

    const composePath = `${workDir}/${stack.composeFilePath}`;
    const catResult = await execArgv(buildClient, ["cat", composePath]);
    if (catResult.code !== 0) {
      throw new Error(`compose file not found: ${stack.composeFilePath}`);
    }
    const rawText = catResult.stdout;
    await db
      .update(stackDeployments)
      .set({ composeSource: rawText })
      .where(eq(stackDeployments.id, deployment.id));

    const doc = parseCompose(rawText, stack.composeFilePath);
    const services = doc.services ?? {};

    sink.write("▸ building services\n");
    const serviceImages = await buildComposeServices({
      buildClient,
      onServiceStart: (key) => sink.write(`▸ ${key}\n`),
      services,
      sha,
      stackName: stack.name,
      stream,
      workDir,
    });

    await db
      .update(stackDeployments)
      .set({ serviceImages, status: "deploying" })
      .where(eq(stackDeployments.id, deployment.id));

    const buildDocker = dockerClient(buildClient);
    // TOUJOURS épinglée, sans condition — voir `placementFor` dans deploy.ts
    // pour le raisonnement complet. Une pile ne va PAS au registre : ses
    // images restent locales au nœud qui les a construites, donc la contrainte
    // n'est jamais un no-op dès qu'un second nœud a rejoint le cluster.
    //
    // Le code d'avant la sautait quand le serveur de la pile était le manager
    // (`sameConnection`), en la croyant sans effet. Mesuré : le planificateur
    // posait la task sur le worker, qui répondait « pull access denied » sur
    // une image construite localement — un déploiement qui « n'a pas convergé
    // en 180 s » sans que la cause apparaisse.
    //
    // Fait sur la connexion de BUILD, jamais celle du manager : c'est un fait
    // LOCAL à ce nœud.
    const placementNodeId =
      server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));

    injectDeployConfig(doc, {
      builtKeys: Object.keys(serviceImages),
      certResolver: ctx.certResolver,
      domain: stack.domain,
      networkName: ctx.networkName,
      placementNodeId,
      port: stack.port,
      publicService: stack.publicService,
      stackName: stack.name,
    });

    sink.write("▸ Swarm rollout (docker stack deploy)\n");
    const { accepted, swarmUpdateStates } = await writeAndDeployStack(ctx, {
      doc,
      managerClient,
      stackName: stack.name,
      stream,
    });

    const finishedAt = new Date();

    if (!accepted) {
      sink.write(
        "✗ Swarm a refusé la bascule d'au moins un service de la pile\n"
      );
      await db
        .update(stackDeployments)
        .set({ finishedAt, status: "rolled_back", swarmUpdateStates })
        .where(eq(stackDeployments.id, deployment.id));
      await db
        .update(stacks)
        .set({ status: "crashed" })
        .where(eq(stacks.id, stack.id));
      return;
    }

    sink.write("✓ deployment accepted\n");
    await db
      .update(stackDeployments)
      .set({
        finishedAt,
        status: "succeeded",
        swarmUpdateStates,
        watchUntil: watchUntilFor(finishedAt),
      })
      .where(eq(stackDeployments.id, deployment.id));

    await db
      .update(stacks)
      .set({ currentDeploymentId: deployment.id, status: "running" })
      .where(eq(stacks.id, stack.id));
    await clearSupersededStackWatch(db, stack.id, deployment.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink.write(`✗ ${message}\n`);
    await db
      .update(stackDeployments)
      .set({ errorMessage: message, finishedAt: new Date(), status: "failed" })
      .where(eq(stackDeployments.id, deployment.id));
    throw err;
  } finally {
    if (managerClient && managerClient !== buildClient) {
      disconnect(managerClient);
    }
    if (buildClient) {
      disconnect(buildClient);
    }
    const { byteSize, storageUrl } = await sink.close();
    await db
      .insert(stackDeploymentLogs)
      .values({ byteSize, stackDeploymentId: deployment.id, storageUrl });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback : rejoue une version passée, sans dépôt ni build
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rejoue un `stack_deployments` passé : le texte compose ET les tags d'image
 * sont déjà en base, donc aucun accès réseau ni au dépôt git ni à un nouveau
 * build — même principe que `redeployImage` pour le chemin mono-service.
 */
export async function redeployStack(
  ctx: DeployContext,
  opts: {
    sourceDeploymentId: string;
    stackId: string;
    trigger: "rollback" | "watch_revert";
  }
): Promise<string> {
  const stack = await ctx.db.query.stacks.findFirst({
    where: eq(stacks.id, opts.stackId),
    with: { server: true },
  });
  if (!stack) {
    throw new Error(`stack not found: ${opts.stackId}`);
  }

  const source = await ctx.db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, opts.sourceDeploymentId),
  });
  if (!source?.composeSource) {
    throw new Error(
      `déploiement source introuvable ou sans compose enregistré : ${opts.sourceDeploymentId}`
    );
  }

  const [created] = await ctx.db
    .insert(stackDeployments)
    .values({
      commitSha: source.commitSha,
      composeSource: source.composeSource,
      serviceImages: source.serviceImages,
      stackId: stack.id,
      status: "deploying",
      trigger: opts.trigger,
    })
    .returning();
  if (!created) {
    throw new Error("could not create stack deployment");
  }

  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    stack.server
  );

  try {
    const doc = parseCompose(source.composeSource, stack.composeFilePath);
    const services = doc.services ?? {};
    const serviceImages = (source.serviceImages ?? {}) as Record<
      string,
      string
    >;
    for (const [key, tag] of Object.entries(serviceImages)) {
      const svc = services[key];
      if (svc) {
        // Reconstruit l'objet plutôt que `delete svc.build` — même raison
        // que dans `buildComposeServices` : la sérialisation YAML d'une clé
        // à `undefined` n'est pas garantie équivalente à son absence.
        const { build: _build, ...rest } = svc;
        services[key] = { ...rest, image: tag };
      }
    }

    const buildDocker = dockerClient(buildClient);
    // Inconditionnelle, même raison qu'au premier déploiement ci-dessus.
    const placementNodeId =
      stack.server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));

    injectDeployConfig(doc, {
      builtKeys: Object.keys(serviceImages),
      certResolver: ctx.certResolver,
      domain: stack.domain,
      networkName: ctx.networkName,
      placementNodeId,
      port: stack.port,
      publicService: stack.publicService,
      stackName: stack.name,
    });

    const { accepted, swarmUpdateStates } = await writeAndDeployStack(ctx, {
      doc,
      managerClient,
      stackName: stack.name,
    });

    await ctx.db
      .update(stackDeployments)
      .set({
        finishedAt: new Date(),
        status: accepted ? "succeeded" : "rolled_back",
        swarmUpdateStates,
      })
      .where(eq(stackDeployments.id, created.id));

    if (accepted) {
      await ctx.db
        .update(stacks)
        .set({ currentDeploymentId: created.id, status: "running" })
        .where(eq(stacks.id, stack.id));
      await clearSupersededStackWatch(ctx.db, stack.id, created.id);
    }

    return created.id;
  } finally {
    if (!sameConnection) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
}
