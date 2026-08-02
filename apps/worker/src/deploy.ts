// Le job de déploiement : la chaîne de la Phase 0, pilotée par la base.
//
//   base → déchiffrement → SSH → clone → build capé → Swarm → relecture d'état
//
// Rien ici ne devine : chaque étape rapporte ce qui s'est réellement passé, et
// l'état final vient de l'API Docker, jamais d'un code de sortie.
import {
  buildImage,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "@noddle/build-engine";
import type { Database } from "@noddle/db";
import {
  deploymentLogs,
  deployments,
  servers,
  services,
} from "@noddle/db/schema";
import { routeLabels } from "@noddle/proxy-config";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { connect, disconnect, dockerClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { createLogSink } from "./log-sink.ts";
import {
  deployService,
  ensureOverlayNetwork,
  isDeployAccepted,
} from "./swarm.ts";
import { watchUntilFor } from "./watch.ts";

export interface DeployContext {
  appKey: Buffer;
  db: Database;
  /** Racine des logs de build sur le plan de contrôle. */
  logRoot: string;
  /** Réseau overlay partagé avec Traefik. */
  networkName: string;
  /** Alimente le flux SSE du dashboard. */
  onLog?: (deploymentId: string, chunk: string) => void;
}

export interface DeployJobData {
  deploymentId: string;
}

export async function runDeploy(
  ctx: DeployContext,
  data: DeployJobData
): Promise<void> {
  const { db } = ctx;

  const deployment = await db.query.deployments.findFirst({
    where: eq(deployments.id, data.deploymentId),
    with: { service: { with: { envVars: true, server: true } } },
  });
  if (!deployment) {
    throw new Error(`déploiement introuvable : ${data.deploymentId}`);
  }

  const { service } = deployment;
  const { server } = service;
  const startedAt = new Date();

  await db
    .update(deployments)
    .set({ startedAt, status: "building" })
    .where(eq(deployments.id, deployment.id));

  const sink = await createLogSink({
    deploymentId: deployment.id,
    onChunk: (c) => ctx.onLog?.(deployment.id, c),
    root: ctx.logRoot,
  });
  const stream = { onStderr: sink.write, onStdout: sink.write };

  let sshClient: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    if (!service.gitRepoUrl) {
      throw new Error("service sans dépôt git : source_type non supporté ici");
    }

    // Déchiffré au plus près de l'usage, jamais journalisé.
    const privateKey = decryptSecret(
      server.sshPrivateKeyEncrypted,
      ctx.appKey,
      secretContext.serverSshKey(server.id)
    );

    sshClient = await connect({
      host: server.host,
      port: server.sshPort,
      privateKey,
      user: server.sshUser,
    });

    // Le plafond se dérive de la mémoire du serveur MOINS ce que le plan de
    // contrôle occupe déjà : sous la topologie retenue, il partage la machine.
    const cap = computeBuildCap({
      totalMemoryMb: server.totalMemoryMb ?? 2048,
    });
    sink.write(`▸ build plafonné à ${cap.memory}\n`);
    await ensureCappedBuilder(sshClient, "noddle-builder", cap, stream);

    const workDir = `/opt/noddle/${service.id}`;
    const sha = await fetchSource(sshClient, {
      branch: service.gitBranch ?? "main",
      commitSha: deployment.commitSha ?? undefined,
      dir: workDir,
      repoUrl: service.gitRepoUrl,
      ...stream,
    });

    const imageTag = `${service.name}:${sha.slice(0, 12)}-${Date.now()}`;
    await db
      .update(deployments)
      .set({ commitSha: sha, imageTag, status: "deploying" })
      .where(eq(deployments.id, deployment.id));

    await buildImage(sshClient, {
      builderName: "noddle-builder",
      dir: workDir,
      imageTag,
      ...stream,
    });

    const env: Record<string, string> = {};
    for (const v of service.envVars) {
      env[v.key] = decryptSecret(
        v.valueEncrypted,
        ctx.appKey,
        secretContext.envVar(v.id)
      );
    }

    const docker = dockerClient(sshClient);
    await ensureOverlayNetwork(docker, ctx.networkName);

    sink.write("▸ bascule Swarm\n");
    const outcome = await deployService(docker, {
      env,
      image: imageTag,
      labels: routeLabels({
        domain: service.domain ?? undefined,
        port: service.port,
        serviceName: service.name,
      }),
      networkName: ctx.networkName,
      port: service.port,
      serviceName: service.name,
    });

    const finishedAt = new Date();

    // LE point qui décide de tout. `docker service update` renvoie 0 même après
    // un rollback : se fier au code de sortie afficherait un déploiement vert
    // pendant que l'ancienne version sert.
    if (!isDeployAccepted(outcome.updateState)) {
      sink.write(
        `✗ Swarm a annulé la bascule (${outcome.updateState}) — l'ancienne version sert toujours\n`
      );
      await db
        .update(deployments)
        .set({
          errorMessage: outcome.updateMessage,
          finishedAt,
          status: "rolled_back",
          swarmUpdateState: outcome.updateState,
        })
        .where(eq(deployments.id, deployment.id));
      await db
        .update(services)
        .set({ status: "crashed" })
        .where(eq(services.id, service.id));
      return;
    }

    sink.write("✓ déploiement accepté\n");
    await db
      .update(deployments)
      .set({
        finishedAt,
        status: "succeeded",
        swarmUpdateState: outcome.updateState,
        // La garantie de Swarm expire avec sa fenêtre monitor. À partir d'ici,
        // c'est la surveillance de Noddle qui couvre les crashs tardifs.
        watchUntil: watchUntilFor(finishedAt),
      })
      .where(eq(deployments.id, deployment.id));

    await db
      .update(services)
      .set({ currentDeploymentId: deployment.id, status: "running" })
      .where(eq(services.id, service.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink.write(`✗ ${message}\n`);
    await db
      .update(deployments)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(deployments.id, deployment.id));
    throw err;
  } finally {
    if (sshClient) {
      disconnect(sshClient);
    }
    // Un POINTEUR vers le fichier, jamais le texte des logs en base.
    const { byteSize, storageUrl } = await sink.close();
    await db
      .insert(deploymentLogs)
      .values({ byteSize, deploymentId: deployment.id, storageUrl });
  }
}

/** Redéploie une image déjà construite — rollback, ou reprise par la surveillance. */
export async function redeployImage(
  ctx: DeployContext,
  opts: {
    serviceId: string;
    imageTag: string;
    trigger: "rollback" | "watch_revert";
  }
): Promise<string> {
  const service = await ctx.db.query.services.findFirst({
    where: eq(services.id, opts.serviceId),
    with: { envVars: true, server: true },
  });
  if (!service) {
    throw new Error(`service introuvable : ${opts.serviceId}`);
  }

  const [created] = await ctx.db
    .insert(deployments)
    .values({
      imageTag: opts.imageTag,
      serviceId: service.id,
      status: "deploying",
      trigger: opts.trigger,
    })
    .returning();

  const privateKey = decryptSecret(
    service.server.sshPrivateKeyEncrypted,
    ctx.appKey,
    secretContext.serverSshKey(service.server.id)
  );
  const client = await connect({
    host: service.server.host,
    port: service.server.sshPort,
    privateKey,
    user: service.server.sshUser,
  });

  try {
    const env: Record<string, string> = {};
    for (const v of service.envVars) {
      env[v.key] = decryptSecret(
        v.valueEncrypted,
        ctx.appKey,
        secretContext.envVar(v.id)
      );
    }

    // Pas de build : l'image existe déjà. C'est précisément ce qui rend le
    // retour arrière instantané, et possible vers N'IMPORTE QUELLE version de
    // l'historique — Swarm, lui, ne garde qu'une spec antérieure.
    const outcome = await deployService(dockerClient(client), {
      env,
      image: opts.imageTag,
      labels: routeLabels({
        domain: service.domain ?? undefined,
        port: service.port,
        serviceName: service.name,
      }),
      networkName: ctx.networkName,
      port: service.port,
      serviceName: service.name,
    });

    const accepted = isDeployAccepted(outcome.updateState);
    await ctx.db
      .update(deployments)
      .set({
        finishedAt: new Date(),
        status: accepted ? "succeeded" : "rolled_back",
        swarmUpdateState: outcome.updateState,
      })
      .where(eq(deployments.id, created?.id ?? ""));

    if (accepted && created) {
      await ctx.db
        .update(services)
        .set({ currentDeploymentId: created.id, status: "running" })
        .where(eq(services.id, service.id));
    }

    return created?.id ?? "";
  } finally {
    disconnect(client);
  }
}

/** Retrouve la mémoire du serveur pour dimensionner le plafond. Idempotent. */
export async function refreshServerFacts(
  ctx: DeployContext,
  serverId: string
): Promise<void> {
  const server = await ctx.db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    return;
  }
  const privateKey = decryptSecret(
    server.sshPrivateKeyEncrypted,
    ctx.appKey,
    secretContext.serverSshKey(server.id)
  );
  const client = await connect({
    host: server.host,
    port: server.sshPort,
    privateKey,
    user: server.sshUser,
  });
  try {
    const docker = dockerClient(client);
    const info = (await docker.info()) as { MemTotal?: number };
    const version = (await docker.version()) as {
      ApiVersion?: string;
      MinAPIVersion?: string;
      Version?: string;
    };
    await ctx.db
      .update(servers)
      .set({
        dockerApiMinVersion: version.MinAPIVersion ?? null,
        dockerVersion: version.Version ?? null,
        status: "connected",
        totalMemoryMb: info.MemTotal
          ? Math.round(info.MemTotal / 1024 / 1024)
          : null,
      })
      .where(eq(servers.id, server.id));
  } finally {
    disconnect(client);
  }
}
