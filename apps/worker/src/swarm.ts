// Déploiement Swarm via l'API Docker Engine (dockerode), pas la CLI.
//
// Pourquoi l'API et pas `docker service update` en shell : la Phase 0 a mesuré
// que la commande renvoie 0 APRÈS un rollback. Le déploiement a échoué, la
// commande a réussi. Se fier au code de sortie fait afficher un déploiement
// vert alors que c'est l'ancienne version qui sert. L'état réel est dans
// UpdateStatus.State, et il ne se lit proprement qu'en structuré.

import type { TraefikLabels } from "@noddle/proxy-config";
import type { DockerApi } from "@noddle/ssh-executor";

/** L'API Swarm exprime toutes les durées en nanosecondes. */
const SECOND_NS = 1_000_000_000;

/**
 * Fenêtre pendant laquelle Swarm surveille une task après l'avoir démarrée.
 *
 * Volontairement courte : elle rallonge chaque déploiement d'autant. La
 * garantie qu'elle offre expire avec elle — au-delà, plus rien à restaurer.
 * C'est la surveillance de Noddle (watch.ts) qui prend le relais, précisément
 * parce qu'allonger cette fenêtre n'est pas la bonne réponse.
 */
export const UPDATE_MONITOR_SECONDS = 45;

export interface DeploySpec {
  /** Déjà déchiffrées. Ne jamais journaliser ce tableau. */
  env: Record<string, string>;
  image: string;
  labels: TraefikLabels;
  networkName: string;
  port: number;
  serviceName: string;
}

export type SwarmUpdateState =
  | "completed"
  | "paused"
  | "rollback_completed"
  | "rollback_paused"
  | "rollback_started"
  | "updating"
  | (string & {});

function serviceSpec(s: DeploySpec) {
  return {
    Labels: s.labels,
    Mode: { Replicated: { Replicas: 1 } },
    Name: s.serviceName,
    Networks: [{ Target: s.networkName }],
    RollbackConfig: {
      // `pause` et non `rollback` : un rollback qui échoue ne doit pas
      // déclencher un rollback du rollback. On s'arrête et on laisse Noddle
      // décider depuis son historique.
      FailureAction: "pause",
      MaxFailureRatio: 0,
      Monitor: UPDATE_MONITOR_SECONDS * SECOND_NS,
      Order: "start-first",
      Parallelism: 1,
    },
    TaskTemplate: {
      ContainerSpec: {
        Env: Object.entries(s.env).map(([k, v]) => `${k}=${v}`),
        // curl est présent dans l'image de base nixpacks, wget non, et node
        // n'est pas dans le PATH d'un shell non-login — or HEALTHCHECK tourne
        // en `sh -c` non-login. Mesuré en Phase 0 ; les trois se ressemblent
        // jusqu'à l'exécution.
        Healthcheck: {
          Interval: 3 * SECOND_NS,
          Retries: 3,
          StartPeriod: 5 * SECOND_NS,
          Test: [
            "CMD-SHELL",
            `curl -fsS -o /dev/null http://127.0.0.1:${s.port}/ || exit 1`,
          ],
          Timeout: 2 * SECOND_NS,
        },
        Image: s.image,
      },
      Networks: [{ Target: s.networkName }],
      RestartPolicy: {
        Condition: "on-failure",
        MaxAttempts: 3,
        Window: 120 * SECOND_NS,
      },
    },
    UpdateConfig: {
      // Le health gate : si la task ne devient jamais saine, Swarm revient en
      // arrière tout seul et l'ancienne version n'a jamais cessé de servir.
      FailureAction: "rollback",
      MaxFailureRatio: 0,
      Monitor: UPDATE_MONITOR_SECONDS * SECOND_NS,
      // La nouvelle task devient saine AVANT que l'ancienne ne soit drainée.
      // C'est ce qui rend le déploiement sans coupure.
      Order: "start-first",
      Parallelism: 1,
    },
  };
}

export interface DeployOutcome {
  created: boolean;
  runningImage: string | null;
  updateMessage: string | null;
  /** Lu sur le service, jamais déduit d'un code de sortie. */
  updateState: SwarmUpdateState | null;
}

async function findService(docker: DockerApi, name: string) {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [name] }),
  });
  // Le filtre `name` de Docker est un préfixe : `api` remonterait `api-staging`.
  return list.find((s) => s.Spec?.Name === name) ?? null;
}

export async function deployService(
  docker: DockerApi,
  spec: DeploySpec
): Promise<DeployOutcome> {
  const existing = await findService(docker, spec.serviceName);

  if (!existing) {
    await docker.createService(serviceSpec(spec));
    const state = await readUpdateState(docker, spec.serviceName);
    return { created: true, ...state };
  }

  const service = docker.getService(existing.ID);
  await service.update({
    ...serviceSpec(spec),
    version: existing.Version?.Index,
  });

  const state = await readUpdateState(docker, spec.serviceName);
  return { created: false, ...state };
}

/**
 * Attend que Swarm ait tranché, puis rapporte ce qu'il a décidé.
 *
 * `updating` n'est pas un verdict : il faut laisser la fenêtre monitor
 * s'écouler, sinon on conclut « réussi » sur un déploiement qui va être annulé
 * dix secondes plus tard.
 */
export async function readUpdateState(
  docker: DockerApi,
  serviceName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<Omit<DeployOutcome, "created">> {
  const timeout = opts.timeoutMs ?? (UPDATE_MONITOR_SECONDS + 60) * 1000;
  const poll = opts.pollMs ?? 2000;
  const deadline = Date.now() + timeout;

  let last: Omit<DeployOutcome, "created"> = {
    runningImage: null,
    updateMessage: null,
    updateState: null,
  };

  while (Date.now() < deadline) {
    // Sondage : chaque tour dépend du précédent, la séquentialité EST le
    // comportement voulu. Rien à paralléliser ici — contrairement au cas où
    // des opérations indépendantes sont sérialisées par inadvertance.
    // biome-ignore lint/performance/noAwaitInLoops: boucle de sondage volontaire
    const found = await findService(docker, serviceName);
    if (!found) {
      return last;
    }

    const raw = found as unknown as {
      UpdateStatus?: { State?: string; Message?: string };
      Spec?: { TaskTemplate?: { ContainerSpec?: { Image?: string } } };
    };

    last = {
      runningImage: raw.Spec?.TaskTemplate?.ContainerSpec?.Image ?? null,
      updateMessage: raw.UpdateStatus?.Message ?? null,
      updateState: raw.UpdateStatus?.State ?? null,
    };

    // Un service tout juste créé n'a pas d'UpdateStatus : il n'y a pas eu de
    // mise à jour. C'est un état final, pas une attente.
    if (!last.updateState) {
      return last;
    }
    if (
      last.updateState !== "updating" &&
      last.updateState !== "rollback_started"
    ) {
      return last;
    }

    await new Promise((r) => setTimeout(r, poll));
  }

  return last;
}

/**
 * Un `updateState` qui n'est ni `completed` ni absent signifie que Swarm a
 * refusé la bascule. Le déploiement a échoué même si aucune commande n'a
 * renvoyé d'erreur.
 */
export function isDeployAccepted(state: SwarmUpdateState | null): boolean {
  return state === null || state === "completed";
}

export async function removeService(
  docker: DockerApi,
  serviceName: string
): Promise<void> {
  const found = await findService(docker, serviceName);
  if (found) {
    await docker.getService(found.ID).remove();
  }
}

/** Le réseau overlay que Traefik et les services partagent. */
export async function ensureOverlayNetwork(
  docker: DockerApi,
  name: string
): Promise<void> {
  const nets = await docker.listNetworks({
    filters: JSON.stringify({ name: [name] }),
  });
  if (nets.some((n) => n.Name === name)) {
    return;
  }
  await docker.createNetwork({
    Attachable: true,
    Driver: "overlay",
    Name: name,
  });
}
