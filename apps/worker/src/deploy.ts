// Le job de déploiement : la chaîne de la Phase 0, pilotée par la base.
//
//   base → déchiffrement → SSH → clone → build capé → Swarm → relecture d'état
//
// Rien ici ne devine : chaque étape rapporte ce qui s'est réellement passé, et
// l'état final vient de l'API Docker, jamais d'un code de sortie.
//
// Phase 2 — multi-serveur : deux connexions distinctes entrent en jeu dès que
// le service n'est pas hébergé sur le manager Swarm.
//
//   BUILD    toujours sur le serveur du service : c'est SON disque qui a
//            besoin du dépôt, SON buildx capé qui produit l'image.
//   SWARM    toujours sur le manager : `docker service create/update` est
//            refusé par un nœud worker, qui ne détient pas l'état répliqué
//            du cluster. Une contrainte de placement épingle ensuite la task
//            au nœud qui a réellement l'image — sans registre, elle n'existe
//            NULLE PART ailleurs, et le planificateur Swarm la placerait
//            aveuglément faute de cette contrainte.
//
// Les deux connexions sont la MÊME sur un cluster à un seul nœud (le cas
// Phase 1, inchangé) : `manager.id === server.id` alors, et `connectTo` ne se
// connecte qu'une fois.
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
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { createLogSink } from "#log-sink";
import { notify } from "#notify";
import {
  deployService,
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
} from "#swarm";
import { watchUntilFor } from "#watch";

export interface DeployContext {
  appKey: Buffer;
  /**
   * Résolveur ACME de Traefik, quand l'installation en a un. Absent = les
   * applications déployées sortent en HTTP simple, ce qui reste le cas
   * d'une machine sans domaine — un certificat ne s'obtient que pour un nom.
   */
  certResolver?: string;
  db: Database;
  /** Racine des logs de build sur le plan de contrôle. */
  logRoot: string;
  /** Réseau overlay partagé avec Traefik. */
  networkName: string;
  /** Alimente le flux SSE du dashboard. */
  onLog?: (deploymentId: string, chunk: string) => void;
}

/**
 * Une seule file porte les deux formes de travail. Volontairement : elles
 * touchent le MÊME service Swarm, et la file est en concurrence 1. Deux files
 * séparées laisseraient un rollback et un déploiement se croiser sur le même
 * service.
 */
export type DeployJobData =
  | { backupId: string; kind: "backup" }
  | { kind: "deploy"; deploymentId: string }
  | { kind: "deploy-stack"; stackDeploymentId: string }
  | { kind: "provision-database"; databaseId: string }
  | { kind: "provision-server"; serverId: string }
  | { backupId: string; databaseId: string; kind: "restore" }
  | { kind: "rollback"; imageTag: string; serviceId: string }
  | { kind: "rollback-stack"; sourceDeploymentId: string; stackId: string };

/** Aiguillage de la file. Le web n'exécute jamais rien de tout ceci : il tourne
 *  sur Bun, où `dockerode` à travers un tunnel SSH ne fonctionne pas. */
export async function runJob(
  ctx: DeployContext,
  data: DeployJobData
): Promise<void> {
  if (data.kind === "rollback") {
    await redeployImage(ctx, {
      imageTag: data.imageTag,
      serviceId: data.serviceId,
      trigger: "rollback",
    });
    return;
  }
  if (data.kind === "provision-server") {
    const { provisionServer } = await import("#provision");
    await provisionServer(ctx, data.serverId);
    return;
  }
  if (data.kind === "provision-database") {
    const { provisionDatabase } = await import("#database");
    await provisionDatabase(ctx, data.databaseId);
    return;
  }
  // Sur la MÊME file que les déploiements, à dessein : concurrence 1. Une
  // sauvegarde nocturne ne tournera donc pas pendant un build, ce qui est le
  // choix conservateur sur une machine à 2 Go — le plafond de build protège
  // du build, pas d'un dump qui s'y ajoute.
  if (data.kind === "backup") {
    const { runBackup } = await import("#backup");
    await runBackup(ctx, data.backupId);
    return;
  }
  if (data.kind === "restore") {
    const { runRestore } = await import("#restore");
    await runRestore(ctx, {
      backupId: data.backupId,
      databaseId: data.databaseId,
    });
    return;
  }
  if (data.kind === "deploy-stack") {
    const { runStackDeploy } = await import("#compose");
    await runStackDeploy(ctx, { stackDeploymentId: data.stackDeploymentId });
    return;
  }
  if (data.kind === "rollback-stack") {
    const { redeployStack } = await import("#compose");
    await redeployStack(ctx, {
      sourceDeploymentId: data.sourceDeploymentId,
      stackId: data.stackId,
      trigger: "rollback",
    });
    return;
  }
  await runDeploy(ctx, data);
}

export type ServerRow = typeof servers.$inferSelect;

/**
 * N'importe quel déploiement encore « sous surveillance » pour ce service
 * cesse de l'être dès qu'un AUTRE déploiement devient le courant : sa fenêtre
 * ne porte plus sur la version qui sert réellement. Le laisser actif fait
 * dérailler la détection — un crash du NOUVEAU déploiement se lit alors comme
 * une boucle de l'ANCIEN, puisque `inspectServiceHealth` vérifie le nom du
 * service Swarm, pas quel déploiement a produit quelle task. Mesuré :
 * `verify-watch.ts` échouait par exactement ce chemin, une version antérieure
 * pourtant saine déclarée en boucle de crash à la place de la vraie coupable.
 */
async function clearSupersededWatch(
  db: Database,
  serviceId: string,
  currentDeploymentId: string
): Promise<void> {
  await db
    .update(deployments)
    .set({ watchUntil: null })
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        ne(deployments.id, currentDeploymentId),
        isNotNull(deployments.watchUntil)
      )
    );
}

/** Ouvre une connexion SSH vers un serveur, déjà déchiffré. */
export async function connectTo(
  ctx: DeployContext,
  server: ServerRow
): ReturnType<typeof connect> {
  const privateKey = decryptSecret(
    server.sshPrivateKeyEncrypted,
    ctx.appKey,
    secretContext.serverSshKey(server.id)
  );
  return await connect({
    host: server.host,
    port: server.sshPort,
    privateKey,
    user: server.sshUser,
  });
}

/**
 * Deux connexions distinctes : build sur le serveur du service, commandes
 * Swarm sur le manager — trouvé par `role`, pas par `isSelf`. La machine qui
 * héberge Noddle est display-only par décision actée, jamais une branche de
 * code ; `role` est le champ qui porte le fait d'orchestration, même si en
 * Phase 2 les deux colonnes désignent toujours la même ligne — parce qu'une
 * seule machine a lancé `docker swarm init`, jamais parce que l'une serait
 * déduite de l'autre.
 *
 * Réutilise la MÊME connexion quand les deux coïncident (le cas
 * mono-serveur), pour ne pas ouvrir une session SSH inutile vers la machine
 * qu'on vient déjà de joindre.
 */
export async function connectForDeploy(
  ctx: DeployContext,
  server: ServerRow
): Promise<{
  buildClient: Awaited<ReturnType<typeof connect>>;
  managerClient: Awaited<ReturnType<typeof connect>>;
  sameConnection: boolean;
}> {
  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    throw new Error(
      "aucun manager Swarm enregistré — l'installateur devrait en avoir créé un"
    );
  }

  const buildClient = await connectTo(ctx, server);
  if (manager.id === server.id) {
    return { buildClient, managerClient: buildClient, sameConnection: true };
  }
  const managerClient = await connectTo(ctx, manager);
  return { buildClient, managerClient, sameConnection: false };
}

export async function runDeploy(
  ctx: DeployContext,
  data: { deploymentId: string }
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

  let buildClient: Awaited<ReturnType<typeof connect>> | undefined;
  let managerClient: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    if (!service.gitRepoUrl) {
      throw new Error("service sans dépôt git : source_type non supporté ici");
    }

    let sameConnection: boolean;
    ({ buildClient, managerClient, sameConnection } = await connectForDeploy(
      ctx,
      server
    ));

    // Le plafond se dérive de la mémoire du serveur MOINS ce que le plan de
    // contrôle occupe déjà : sous la topologie retenue, il partage la machine.
    const cap = computeBuildCap({
      totalMemoryMb: server.totalMemoryMb ?? 2048,
    });
    sink.write(`▸ build plafonné à ${cap.memory}\n`);
    await ensureCappedBuilder(buildClient, "noddle-builder", cap, stream);

    const workDir = `/opt/noddle/${service.id}`;
    const sha = await fetchSource(buildClient, {
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

    await buildImage(buildClient, {
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

    const buildDocker = dockerClient(buildClient);
    // L'ID du nœud qui vient de construire l'image — lu sur la connexion de
    // BUILD, jamais sur celle du manager quand elles diffèrent : c'est un
    // fait local à ce nœud, que `docker info` rapporte correctement même
    // depuis un worker.
    const placementNodeId = sameConnection
      ? undefined
      : await getSwarmNodeId(buildDocker);

    const managerDocker = sameConnection
      ? buildDocker
      : dockerClient(managerClient);
    await ensureOverlayNetwork(managerDocker, ctx.networkName);

    sink.write("▸ bascule Swarm\n");
    const outcome = await deployService(managerDocker, {
      env,
      image: imageTag,
      labels: routeLabels({
        certResolver: ctx.certResolver,
        domain: service.domain ?? undefined,
        port: service.port,
        serviceName: service.name,
      }),
      networkName: ctx.networkName,
      placementNodeId,
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
      await notify(ctx, {
        detail: outcome.updateMessage ?? undefined,
        resource: service.name,
        type: "deploy_reverted",
      });
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
    await clearSupersededWatch(db, service.id, deployment.id);
    await notify(ctx, {
      detail: deployment.commitSha ?? undefined,
      resource: service.name,
      type: "deploy_succeeded",
    });
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
    await notify(ctx, {
      detail: message,
      resource: service.name,
      type: "deploy_failed",
    });
    throw err;
  } finally {
    // Identité d'objet, pas `sameConnection` : cette variable est scopée au
    // bloc `try` pour éviter un faux positif Biome sur une réaffectation par
    // déstructuration d'un `let` extérieur. L'identité est de toute façon
    // l'invariant réel : ne jamais fermer deux fois la MÊME connexion.
    if (managerClient && managerClient !== buildClient) {
      disconnect(managerClient);
    }
    if (buildClient) {
      disconnect(buildClient);
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

  // Le commit que cette image porte, repris du déploiement qui l'a construite.
  //
  // Sans ça, la ligne « retour arrière » de l'historique affiche « — » en
  // commit : le dashboard sait quelle IMAGE tourne mais plus quel CODE, et
  // « quel commit est en production ? » est précisément la question qu'on pose
  // juste après un rollback.
  const origin = await ctx.db.query.deployments.findFirst({
    orderBy: desc(deployments.createdAt),
    where: and(
      eq(deployments.serviceId, service.id),
      eq(deployments.imageTag, opts.imageTag)
    ),
  });

  const [created] = await ctx.db
    .insert(deployments)
    .values({
      commitSha: origin?.commitSha ?? null,
      imageTag: opts.imageTag,
      serviceId: service.id,
      status: "deploying",
      trigger: opts.trigger,
    })
    .returning();

  // Pas de build ici : l'image existe déjà sur SON serveur. La commande Swarm,
  // elle, doit quand même passer par le manager — et la contrainte de
  // placement vise le serveur du service, pas celui qui reçoit la commande.
  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    service.server
  );

  try {
    const env: Record<string, string> = {};
    for (const v of service.envVars) {
      env[v.key] = decryptSecret(
        v.valueEncrypted,
        ctx.appKey,
        secretContext.envVar(v.id)
      );
    }

    const buildDocker = dockerClient(buildClient);
    const placementNodeId = sameConnection
      ? undefined
      : await getSwarmNodeId(buildDocker);
    const managerDocker = sameConnection
      ? buildDocker
      : dockerClient(managerClient);

    // Pas de build : l'image existe déjà. C'est précisément ce qui rend le
    // retour arrière instantané, et possible vers N'IMPORTE QUELLE version de
    // l'historique — Swarm, lui, ne garde qu'une spec antérieure.
    const outcome = await deployService(managerDocker, {
      env,
      image: opts.imageTag,
      labels: routeLabels({
        certResolver: ctx.certResolver,
        domain: service.domain ?? undefined,
        port: service.port,
        serviceName: service.name,
      }),
      networkName: ctx.networkName,
      placementNodeId,
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
      await clearSupersededWatch(ctx.db, service.id, created.id);
    }

    return created?.id ?? "";
  } finally {
    if (!sameConnection) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
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
  const client = await connectTo(ctx, server);
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
