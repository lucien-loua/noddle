// Rétention du registre.
//
// Sans elle, le registre grossit sans fin : chaque déploiement d'une
// application Node ordinaire y dépose ~245 Mo de couches compressées, mesuré.
// Sur les 19 Go d'un petit VPS ça se remplit en quelques dizaines de
// déploiements — et la panne arriverait sous la forme d'un build qui échoue,
// sans que rien ne désigne le registre.
//
// Même forme que `sweepBackups` et `sweepWatch` : un passage qui interroge
// Postgres, module séparé d'index.ts pour être testable sans démarrer le
// processus.
//
// ⚠ À DÉPOSER SUR LA FILE DES DÉPLOIEMENTS, en concurrence 1. Ce n'est pas un
// détail de câblage : `garbage-collect` supprime les couches qu'aucun
// manifeste ne référence, et une couche EN COURS D'ENVOI est exactement dans
// ce cas. Un GC concurrent d'un push publierait une image incomplète — la même
// famille de panne que le dump tronqué des sauvegardes, où tout réussit et le
// résultat est faux.
import { deployments, servers } from "@noddle/db/schema";
import { disconnect } from "@noddle/ssh-executor";
import { desc, eq, inArray } from "drizzle-orm";
import { connectTo, type DeployContext } from "#deploy";
import {
  deleteManifest,
  garbageCollect,
  KEEP_PER_SERVICE,
  parseRegistryRef,
  type RegistryConfig,
} from "#registry";

/** Le nom du conteneur du registre dans la pile Compose du plan de contrôle. */
const REGISTRY_CONTAINER = "noddle-registry-1";

export interface RegistrySweepResult {
  /** `true` si le garbage-collect a tourné — donc si des octets ont pu revenir. */
  collected: boolean;
  /** Tags d'images retirés du registre. */
  purged: string[];
}

interface PurgeCandidate {
  /** Toutes les lignes d'historique qui portent ce tag. */
  deploymentIds: string[];
  imageTag: string;
}

/**
 * Quels tags d'un service sortent de la fenêtre de rétention.
 *
 * Pure, donc vérifiable sans registre ni base — et c'est ici que vivent les
 * deux règles qui comptent :
 *
 *   - on compte des TAGS DISTINCTS, pas des lignes. Un rollback crée une
 *     nouvelle ligne d'historique avec le MÊME tag ; compter les lignes
 *     purgerait des images encore jeunes.
 *   - l'image du déploiement COURANT n'est jamais candidate, même sortie de
 *     la fenêtre. Ce qui arrive dès qu'on rejoue une vieille version : elle
 *     redevient courante sans redevenir récente.
 */
export function tagsToPurge(opts: {
  currentImageTag: string | null;
  registry: RegistryConfig;
  rows: { id: string; imagePurged: boolean; imageTag: string | null }[];
}): PurgeCandidate[] {
  const byTag = new Map<string, string[]>();
  for (const row of opts.rows) {
    if (!row.imageTag || row.imagePurged) {
      continue;
    }
    // Image d'avant le registre : elle n'y est pas, il n'y a rien à y
    // supprimer. Elle vit dans le magasin local de son nœud, et c'est le
    // `docker image prune` de l'utilisateur qui la concerne, pas nous.
    if (!parseRegistryRef(row.imageTag, opts.registry)) {
      continue;
    }
    const ids = byTag.get(row.imageTag);
    if (ids) {
      ids.push(row.id);
    } else {
      byTag.set(row.imageTag, [row.id]);
    }
  }

  const candidates: PurgeCandidate[] = [];
  let rank = 0;
  for (const [imageTag, deploymentIds] of byTag) {
    rank += 1;
    if (rank > KEEP_PER_SERVICE && imageTag !== opts.currentImageTag) {
      candidates.push({ deploymentIds, imageTag });
    }
  }
  return candidates;
}

/** Retire du registre les images trop anciennes, service par service. */
export async function sweepRegistry(
  ctx: DeployContext,
  opts: { containerName?: string } = {}
): Promise<RegistrySweepResult> {
  const result: RegistrySweepResult = { collected: false, purged: [] };
  const { registry } = ctx;
  if (!registry) {
    return result;
  }

  const all = await ctx.db.query.services.findMany();
  const candidates: PurgeCandidate[] = [];

  for (const service of all) {
    // biome-ignore lint/performance/noAwaitInLoops: un service à la fois, volontairement
    const rows = await ctx.db.query.deployments.findMany({
      orderBy: desc(deployments.createdAt),
      where: eq(deployments.serviceId, service.id),
    });
    const current = rows.find((r) => r.id === service.currentDeploymentId);
    candidates.push(
      ...tagsToPurge({
        currentImageTag: current?.imageTag ?? null,
        registry,
        rows,
      })
    );
  }

  for (const { deploymentIds, imageTag } of candidates) {
    const ref = parseRegistryRef(imageTag, registry);
    if (!ref) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: un manifeste à la fois, volontairement
    const gone = await deleteManifest(registry, ref);
    if (!gone) {
      continue;
    }
    // La ligne d'historique RESTE — quel commit a tourné quand n'a pas à
    // disparaître parce qu'on a récupéré du disque. Seul le fait « l'image
    // n'existe plus » est enregistré, pour que le dashboard cesse de proposer
    // un rollback qu'il sait impossible.
    await ctx.db
      .update(deployments)
      .set({ imagePurged: true })
      .where(inArray(deployments.id, deploymentIds));
    result.purged.push(imageTag);
  }

  if (result.purged.length === 0) {
    return result;
  }

  // Supprimer les manifestes ne rend RIEN — mesuré : les tags disparaissent et
  // le volume ne bouge pas d'un octet. Sans cette étape, la rétention donnerait
  // un dashboard propre et un disque qui se remplit quand même, c'est-à-dire
  // exactement le défaut qu'elle est censée corriger.
  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    return result;
  }
  const client = await connectTo(ctx, manager);
  try {
    await garbageCollect(client, opts.containerName ?? REGISTRY_CONTAINER);
    result.collected = true;
  } finally {
    disconnect(client);
  }
  return result;
}
