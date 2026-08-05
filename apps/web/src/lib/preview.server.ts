// Les environnements de prévisualisation par pull request.
//
// Une prévisualisation est un `services` ORDINAIRE — elle construit, déploie,
// a des logs, un historique, un rollback, des métriques et une surveillance
// post-déploiement. Deux colonnes la distinguent : `previewOfServiceId` et
// `prNumber`. Voir `packages/db/src/schema/services.ts`.
//
// Ce module ne s'exécute JAMAIS depuis une session : son appelant est le
// récepteur de webhook, authentifié par signature. Il ne fait donc aucun
// contrôle de permission — il n'y a personne à qui en demander.
import { environments, envVars, services } from "@noddle/db/schema";
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/shared/crypto";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { enqueueDeploy } from "@/lib/queue.server";

/**
 * Combien de prévisualisations peuvent vivre en même temps, sur toute
 * l'installation.
 *
 * Une constante, pas un réglage : la machine est ce qui casse, et un plafond
 * qu'on peut lever n'en est pas un. Mesuré sur le VPS — une application
 * déployée pèse ~51 Mio, le plan de contrôle ~388 Mio ; mais une vraie
 * application Next.js monte à 200-400 Mio, et la cible de conception reste une
 * machine à 2 Go. Cinq est ce qui tient sans affamer le service de production
 * qui partage la même machine.
 */
export const PREVIEW_LIMIT = 5;

/** L'environnement où vivent les prévisualisations d'un projet. */
const PREVIEW_ENVIRONMENT = "preview";

/**
 * `<parent>-pr-<n>`, tronqué pour tenir dans `serviceNameSchema` (48).
 *
 * Le suffixe est ce qui doit survivre : deux prévisualisations du même parent
 * ne se distinguent que par lui. C'est donc le PRÉFIXE qu'on coupe.
 */
export function previewServiceName(
  parentName: string,
  prNumber: number
): string {
  const suffix = `-pr-${prNumber}`;
  return `${parentName.slice(0, 48 - suffix.length)}${suffix}`;
}

export type PreviewOutcome =
  | { created: boolean; deploymentId: string; serviceId: string }
  | { ignored: string };

/**
 * Crée la prévisualisation si elle n'existe pas, puis la déploie au commit de
 * la PR. Un `synchronize` retombe sur la MÊME ligne — l'index unique partiel
 * `(preview_of_service_id, pr_number)` l'impose, sans quoi chaque push sur la
 * branche laisserait un service de plus.
 */
export async function ensurePreview(opts: {
  commitSha: string;
  headBranch: string;
  parentServiceId: string;
  prNumber: number;
}): Promise<PreviewOutcome> {
  const parent = await db.query.services.findFirst({
    where: eq(services.id, opts.parentServiceId),
    with: { environment: true, envVars: true },
  });
  if (!parent) {
    return { ignored: "parent service not found" };
  }

  // Sans domaine sur le parent, la prévisualisation n'aurait pas d'URL — et
  // une prévisualisation qu'on ne peut pas ouvrir ne sert à rien. On le dit
  // plutôt que de déployer quelque chose d'inatteignable.
  if (!parent.domain) {
    return {
      ignored:
        "the parent service has no domain, so a preview would have no URL",
    };
  }

  const existing = await db.query.services.findFirst({
    where: and(
      eq(services.previewOfServiceId, parent.id),
      eq(services.prNumber, opts.prNumber)
    ),
  });

  if (existing) {
    // La branche d'une PR ne bouge pas, mais son commit si : on redéploie la
    // ligne existante au nouveau SHA.
    const { deploymentId } = await queueServiceDeploy(existing.id, {
      commitSha: opts.commitSha,
      trigger: "webhook",
    });
    return { created: false, deploymentId, serviceId: existing.id };
  }

  // Le plafond ne compte que les prévisualisations VIVANTES : une qui est en
  // cours de démontage libère déjà sa place.
  const live = await db.query.services.findMany({
    where: and(
      isNotNull(services.previewOfServiceId),
      ne(services.status, "deleting")
    ),
  });
  if (live.length >= PREVIEW_LIMIT) {
    return {
      ignored: `preview limit reached (${PREVIEW_LIMIT} live) — close a pull request to free one`,
    };
  }

  const environment = await previewEnvironment(parent.environment.projectId);
  const serviceId = await createPreview(parent, environment.id, opts);

  const { deploymentId } = await queueServiceDeploy(serviceId, {
    commitSha: opts.commitSha,
    trigger: "webhook",
  });
  return { created: true, deploymentId, serviceId };
}

/** Retrouve-ou-crée l'environnement `preview` du projet. */
async function previewEnvironment(projectId: string) {
  const found = await db.query.environments.findFirst({
    where: and(
      eq(environments.projectId, projectId),
      eq(environments.name, PREVIEW_ENVIRONMENT)
    ),
  });
  if (found) {
    return found;
  }
  const [created] = await db
    .insert(environments)
    .values({ name: PREVIEW_ENVIRONMENT, projectId })
    .returning();
  if (!created) {
    throw new Error("could not create the preview environment");
  }
  return created;
}

type ParentService = typeof services.$inferSelect & {
  envVars: (typeof envVars.$inferSelect)[];
};

async function createPreview(
  parent: ParentService,
  environmentId: string,
  opts: { commitSha: string; headBranch: string; prNumber: number }
): Promise<string> {
  const [preview] = await db
    .insert(services)
    .values({
      buildMethod: parent.buildMethod,
      // `pr-<n>.` devant le domaine du parent. Sur un vrai domaine ça exige un
      // enregistrement DNS joker que Noddle ne peut pas poser ; en sslip.io
      // n'importe quel sous-domaine résout déjà.
      domain: `pr-${opts.prNumber}.${parent.domain}`,
      environmentId,
      gitBranch: opts.headBranch,
      gitRepoUrl: parent.gitRepoUrl,
      name: previewServiceName(parent.name, opts.prNumber),
      port: parent.port,
      previewOfServiceId: parent.id,
      prNumber: opts.prNumber,
      serverId: parent.serverId,
      sourceType: parent.sourceType,
    })
    .returning();
  if (!preview) {
    throw new Error("could not create the preview service");
  }

  await copyEnvVars(parent, preview.id);
  return preview.id;
}

/**
 * Les variables du parent, SECRETS COMPRIS.
 *
 * C'est la décision « comme Vercel » : une prévisualisation qui ne démarre pas
 * faute de `DATABASE_URL` ne sert à rien. Le garde-fou n'est pas ici mais en
 * amont — aucune prévisualisation n'est créée pour une PR venant d'un FORK,
 * qui est le seul cas où le code exécuté n'est pas celui de gens de confiance.
 *
 * Copiées et non partagées : chaque valeur est REchiffrée sous l'identifiant
 * de SA nouvelle ligne, parce que l'AAD lie le chiffré à la ligne. Conséquence
 * voulue — on peut corriger une variable sur une prévisualisation sans toucher
 * à la production.
 */
async function copyEnvVars(
  parent: ParentService,
  previewServiceId: string
): Promise<void> {
  if (parent.envVars.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    for (const v of parent.envVars) {
      const value = decryptSecret(
        v.valueEncrypted,
        env.appKey,
        secretContext.envVar(v.id)
      );
      // Insertion en DEUX temps : l'AAD a besoin de l'identifiant de la
      // nouvelle ligne, qui n'existe pas avant l'insert. Même forme que
      // l'adoption de l'hôte pour la clé SSH.
      // biome-ignore lint/performance/noAwaitInLoops: écritures ordonnées dans une transaction
      const [row] = await tx
        .insert(envVars)
        .values({
          isSecret: v.isSecret,
          key: v.key,
          serviceId: previewServiceId,
          valueEncrypted: "placeholder",
        })
        .returning();
      if (!row) {
        throw new Error("could not copy an environment variable");
      }
      await tx
        .update(envVars)
        .set({
          valueEncrypted: encryptSecret(
            value,
            env.appKey,
            secretContext.envVar(row.id)
          ),
        })
        .where(eq(envVars.id, row.id));
    }
  });
}

/**
 * Démonte la prévisualisation d'une PR fermée.
 *
 * Exactement le même chemin que le bouton « Delete » du dashboard : marquer
 * `deleting`, puis déposer le démontage sur la file des déploiements. Le
 * service Swarm doit disparaître AVANT la ligne — voir `teardown.ts`.
 */
export async function destroyPreview(opts: {
  parentServiceId: string;
  prNumber: number;
}): Promise<PreviewOutcome | { destroyed: string }> {
  const preview = await db.query.services.findFirst({
    where: and(
      eq(services.previewOfServiceId, opts.parentServiceId),
      eq(services.prNumber, opts.prNumber)
    ),
  });
  if (!preview) {
    // Une PR fermée sans prévisualisation — un fork, une PR ouverte avant que
    // le webhook existe, ou un démontage déjà passé. Rien à faire, et surtout
    // pas une erreur.
    return { ignored: "no preview for this pull request" };
  }

  await db
    .update(services)
    .set({ status: "deleting" })
    .where(eq(services.id, preview.id));
  await enqueueDeploy({ kind: "delete-service", serviceId: preview.id });
  return { destroyed: preview.id };
}
