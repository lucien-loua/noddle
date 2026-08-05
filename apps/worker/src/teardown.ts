// Supprimer un service, pour de bon.
//
// Le produit n'avait aucun chemin de suppression jusqu'ici : `removeService`
// n'était appelé que par les scripts de vérification, et retirer un service
// demandait du SQL et du docker en ligne de commande.
//
// L'ORDRE est la seule chose qui compte vraiment ici :
//
//   1. le service Swarm   — doit réussir. Tant qu'il tourne, Traefik y route :
//                           un utilisateur qui a cliqué « Supprimer » verrait
//                           son application répondre encore. C'est le mensonge
//                           le plus grave des deux, donc rien ne continue si
//                           cette étape échoue.
//   2. les lignes en base — une fois l'application arrêtée, l'écran peut dire
//                           la vérité.
//   3. le reste           — images, répertoire de build, fichiers de logs. Au
//                           mieux : ce ne sont que des octets, et échouer ici
//                           ne doit pas laisser la ligne coincée en `deleting`.
import { unlink } from "node:fs/promises";
import { deployments, services } from "@noddle/db/schema";
import { disconnect, dockerClient, execArgv } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { BUILD_ROOT, connectForDeploy, type DeployContext } from "#deploy";
import { deleteManifest, garbageCollect, parseRegistryRef } from "#registry";
import { removeService } from "#swarm";

/** Le conteneur du registre dans la pile Compose du plan de contrôle. */
const REGISTRY_CONTAINER = "noddle-registry-1";

const FILE_URL = "file://";

export async function runServiceTeardown(
  ctx: DeployContext,
  serviceId: string,
  opts: { containerName?: string } = {}
): Promise<void> {
  const service = await ctx.db.query.services.findFirst({
    where: eq(services.id, serviceId),
    with: { server: true },
  });
  if (!service) {
    // Déjà supprimé — le job a peut-être été rejoué. Rien à faire, et surtout
    // pas une erreur : le résultat voulu est atteint.
    return;
  }

  const rows = await ctx.db.query.deployments.findMany({
    where: eq(deployments.serviceId, serviceId),
    with: { logs: true },
  });

  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    service.server
  );

  try {
    // ── 1. Swarm — doit réussir ──────────────────────────────────────────
    const managerDocker = sameConnection
      ? dockerClient(buildClient)
      : dockerClient(managerClient);
    await removeService(managerDocker, service.name);

    // ── 2. la base — l'écran peut désormais dire la vérité ───────────────
    // `deployments`, `deployment_logs`, `env_vars` et `service_metrics`
    // partent en cascade (voir le schéma).
    await ctx.db.delete(services).where(eq(services.id, serviceId));

    // ── 3. les octets — au mieux, jamais bloquant ────────────────────────
    await purgeBytes(ctx, {
      buildClient,
      imageTags: rows.map((r) => r.imageTag).filter((t): t is string => !!t),
      logPaths: rows.flatMap((r) =>
        r.logs
          .map((l) => l.storageUrl)
          .filter((u) => u.startsWith(FILE_URL))
          .map((u) => u.slice(FILE_URL.length))
      ),
      managerClient: sameConnection ? buildClient : managerClient,
      registryContainer: opts.containerName ?? REGISTRY_CONTAINER,
      serviceId,
    });
  } finally {
    if (!sameConnection) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
}

/**
 * Tout ce qui n'est que de l'espace disque. Chaque étape est isolée : une qui
 * échoue ne doit pas empêcher les suivantes, et aucune ne doit faire échouer
 * la suppression — le service est déjà arrêté et la ligne déjà partie.
 */
async function purgeBytes(
  ctx: DeployContext,
  o: {
    buildClient: Parameters<typeof dockerClient>[0];
    imageTags: string[];
    logPaths: string[];
    managerClient: Parameters<typeof dockerClient>[0];
    registryContainer: string;
    serviceId: string;
  }
): Promise<void> {
  // Le répertoire de clone sur le serveur de build.
  await execArgv(o.buildClient, [
    "sudo",
    "rm",
    "-rf",
    `${BUILD_ROOT}/${o.serviceId}`,
  ]).catch(() => undefined);

  // Les images locales, s'il en reste (une version d'avant le registre, ou
  // une image re-tirée par le nœud qui exécutait le service).
  for (const tag of o.imageTags) {
    // biome-ignore lint/performance/noAwaitInLoops: une image à la fois, volontairement
    await execArgv(o.buildClient, ["sudo", "docker", "rmi", "-f", tag]).catch(
      () => undefined
    );
  }

  // Le dépôt dans le registre : chaque tag, puis le ramasse-miettes — sans
  // quoi les couches resteraient, mesuré.
  if (ctx.registry) {
    let deletedAny = false;
    for (const tag of o.imageTags) {
      const ref = parseRegistryRef(tag, ctx.registry);
      if (!ref) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: un manifeste à la fois, volontairement
      const gone = await deleteManifest(ctx.registry, ref).catch(() => false);
      deletedAny = deletedAny || gone;
    }
    if (deletedAny) {
      await garbageCollect(o.managerClient, o.registryContainer).catch(
        () => undefined
      );
    }
  }

  // Les fichiers de logs, sur le plan de contrôle — pas sur la cible.
  for (const path of o.logPaths) {
    // biome-ignore lint/performance/noAwaitInLoops: un fichier à la fois, volontairement
    await unlink(path).catch(() => undefined);
  }
}
