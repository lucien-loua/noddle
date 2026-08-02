// Passage de surveillance : rattrape les crashs que Swarm ne rattrape plus.
//
// Module séparé de index.ts pour être testable sans démarrer le processus, et
// séparé de watch.ts pour éviter un cycle d'import — il a besoin de
// redeployImage, qui a besoin de watchUntilFor.
//
// Phase 2 — multi-serveur : `docker.listTasks`/`listServices` lit l'état
// répliqué du cluster, que seul un MANAGER détient. Un worker y répondrait
// par une erreur — d'où la connexion systématique au manager, jamais à
// `service.server` quand les deux diffèrent.
import { deployments, servers, services } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { connect, disconnect, dockerClient } from "@noddle/ssh-executor";
import { and, desc, eq, gt, isNotNull, lt, ne } from "drizzle-orm";
import { type DeployContext, redeployImage } from "#deploy";
import { inspectServiceHealth } from "#watch";

export interface SweepResult {
  /** Déploiements encore sous surveillance à ce passage. */
  inspected: number;
  /** Déploiements dont la boucle de crash a été détectée. */
  reverted: string[];
  /** Détectés mais sans version antérieure vers laquelle revenir. */
  strandedServices: string[];
}

export async function sweepWatch(ctx: DeployContext): Promise<SweepResult> {
  const now = new Date();
  const pending = await ctx.db.query.deployments.findMany({
    where: and(
      eq(deployments.status, "succeeded"),
      isNotNull(deployments.watchUntil),
      gt(deployments.watchUntil, now)
    ),
    with: { service: { with: { server: true } } },
  });

  const reverted: string[] = [];
  const strandedServices: string[] = [];

  if (pending.length === 0) {
    return { inspected: 0, reverted, strandedServices };
  }

  // Un seul manager : une connexion pour tout le passage, pas une par
  // déploiement inspecté.
  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    throw new Error("aucun manager Swarm enregistré");
  }
  const privateKey = decryptSecret(
    manager.sshPrivateKeyEncrypted,
    ctx.appKey,
    secretContext.serverSshKey(manager.id)
  );
  const managerClient = await connect({
    host: manager.host,
    port: manager.sshPort,
    privateKey,
    user: manager.sshUser,
  });
  const docker = dockerClient(managerClient);

  try {
    await Promise.all(
      pending.map(async (dep) => {
        const { service } = dep;

        const verdict = await inspectServiceHealth(
          docker,
          service.name,
          dep.finishedAt ?? dep.createdAt
        );
        if (!verdict.crashLooping) {
          return;
        }

        // La version antérieure qui a réellement servi. Noddle vise n'importe
        // quelle entrée de son historique — Swarm n'en garde qu'une.
        const previous = await ctx.db.query.deployments.findFirst({
          orderBy: desc(deployments.createdAt),
          where: and(
            eq(deployments.serviceId, service.id),
            eq(deployments.status, "succeeded"),
            ne(deployments.id, dep.id),
            isNotNull(deployments.imageTag),
            lt(deployments.createdAt, dep.createdAt)
          ),
        });

        await ctx.db
          .update(deployments)
          .set({
            errorMessage: `boucle de crash après déploiement (${verdict.failures} échecs) : ${verdict.lastError ?? "sans détail"}`,
            status: "reverted_by_watch",
            watchUntil: null,
          })
          .where(eq(deployments.id, dep.id));

        if (!previous?.imageTag) {
          // Première version du service : rien vers quoi revenir. On le signale
          // plutôt que de masquer l'état.
          await ctx.db
            .update(services)
            .set({ status: "crashed" })
            .where(eq(services.id, service.id));
          strandedServices.push(service.id);
          return;
        }

        await redeployImage(ctx, {
          imageTag: previous.imageTag,
          serviceId: service.id,
          trigger: "watch_revert",
        });
        reverted.push(dep.id);
      })
    );
  } finally {
    disconnect(managerClient);
  }

  return { inspected: pending.length, reverted, strandedServices };
}
