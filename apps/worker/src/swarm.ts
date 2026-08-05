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

/**
 * Le nom du service Swarm — et pourquoi ce n'est PAS `services.name`.
 *
 * L'unicité en base est `(environment_id, name)`. Celle de Swarm est GLOBALE.
 * Deux services `api`, l'un en `production` et l'autre en `staging`, désignent
 * donc le MÊME service Swarm : le second déploiement écrase le premier, sans
 * la moindre erreur. Et ce n'est pas théorique — `connectRepo` expose déjà
 * `environmentName`, donc le cas s'atteint depuis le formulaire aujourd'hui.
 *
 * Pourquoi un suffixe d'identifiant plutôt que `projet-environnement-service`,
 * qui se lirait mieux : un nom de service Swarm devient un nom DNS sur le
 * réseau overlay, donc 63 octets au plus. Projet et environnement font jusqu'à
 * 64 caractères CHACUN — la forme lisible ne tient pas, et la tronquer
 * rouvrirait la collision qu'elle est censée fermer.
 *
 * Huit hexadécimaux d'un UUID : 48 + 1 + 8 = 57 au pire, sous la limite. Le
 * nom lisible reste en tête, donc `docker service ls | grep api` fonctionne
 * toujours.
 */
export function swarmServiceName(service: {
  id: string;
  name: string;
}): string {
  return `${service.name}-${service.id.replaceAll("-", "").slice(0, 8)}`;
}

export interface DeploySpec {
  /** Déjà déchiffrées. Ne jamais journaliser ce tableau. */
  env: Record<string, string>;
  image: string;
  labels: TraefikLabels;
  networkName: string;
  /**
   * ID Swarm du nœud qui a construit l'image, à distinguer d'un ID de base de
   * données : c'est `docker info` sur CE nœud qui le donne, valeur locale au
   * cluster Swarm et pas un identifiant que Noddle invente.
   *
   * `undefined` quand l'image est PORTABLE — c'est-à-dire qu'elle vit dans le
   * registre : Swarm peut alors la placer où il veut, et c'est précisément ce
   * qu'on cherche. `undefined` aussi sur un cluster à un seul nœud, où la
   * contrainte serait un no-op.
   *
   * Renseigné pour toute image LOCALE à un nœud, y compris un rollback vers
   * une image d'avant le registre : elle n'existe nulle part ailleurs, et
   * Swarm planifierait aveuglément une task qui ne la trouvera jamais. La
   * décision se prend donc image par image, jamais globalement.
   */
  placementNodeId?: string;
  port: number;
  /**
   * Identifiants du registre, transmis à Swarm et non employés ici.
   *
   * Le manager les chiffre dans la spec du service et les distribue aux
   * agents : ce sont EUX qui tirent, sur des nœuds où Noddle n'ouvre aucune
   * session. C'est l'équivalent API de `--with-registry-auth`, et c'est ce qui
   * évite un `docker login` persistant sur chaque machine.
   */
  registryAuth?: RegistryAuth;
  serviceName: string;
}

/** La forme attendue par l'en-tête `X-Registry-Auth` de l'API Engine. */
export interface RegistryAuth {
  password: string;
  serveraddress: string;
  username: string;
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
      // Absent (pas `{ Constraints: [] }`) sur un seul nœud : une liste vide
      // est déjà correcte pour l'API, mais la distinction reste plus honnête
      // sur ce qui est réellement demandé.
      ...(s.placementNodeId
        ? { Placement: { Constraints: [`node.id==${s.placementNodeId}`] } }
        : {}),
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

/**
 * Attend qu'une task du service soit réellement `running`.
 *
 * Avec un HEALTHCHECK, Swarm garde la task en `starting` tant qu'elle n'est pas
 * saine : atteindre `running` vaut donc health gate à la création, exactement
 * comme UpdateStatus le fait pour une mise à jour.
 */
/**
 * Exportée pour `compose.ts` : un déploiement de pile appelle `docker stack
 * deploy`, qui rend la main avant convergence exactement comme `docker
 * service update` — chaque service résultant a besoin de CE MÊME sondage, un
 * par un.
 */
export async function waitForRunningTask(
  docker: DockerApi,
  serviceName: string,
  timeoutMs = 180_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: boucle de sondage volontaire
    const tasks = (await docker.listTasks({
      filters: JSON.stringify({ service: [serviceName] }),
    })) as unknown as Array<{
      DesiredState?: string;
      Status?: { Err?: string; State?: string };
    }>;

    if (tasks.some((t) => t.Status?.State === "running")) {
      return;
    }
    const dead = tasks.filter(
      (t) => t.Status?.State === "failed" || t.Status?.State === "rejected"
    );
    if (dead.length > 0) {
      lastError = dead.at(-1)?.Status?.Err ?? "";
    }
    // La restart policy retente : on ne sort pas au premier échec, on laisse
    // le délai courir. Un service qui ne converge jamais finira en timeout.
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(
    `service ${serviceName} did not converge within ${timeoutMs / 1000}s${lastError ? ` — ${lastError}` : ""}`
  );
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

  // L'authentification passe en PREMIER ARGUMENT POSITIONNEL, jamais dans les
  // options. Mesuré contre une vraie VM, et c'est une chausse-trappe de
  // dockerode :
  //
  //   Docker.prototype.createService = function (auth, opts, callback) {
  //     if (!callback && typeof opts === 'function') { … auth = opts.authconfig }
  //     else if (!opts && !callback) { opts = auth }   ← auth reste la SPEC
  //
  // Appelé avec un seul argument — la forme promesse — `auth` demeure la spec
  // entière, que docker-modem encode en base64 dans `X-Registry-Auth`. Le
  // démon n'y trouve aucun identifiant, et l'agent qui tire répond « no basic
  // auth credentials » : un déploiement qui ne converge pas, dont le message
  // ne désigne pas la cause.
  //
  // `Service.prototype.update`, lui, extrait bien `opts.authconfig` dans ce
  // cas. L'asymétrie fait que seule une CRÉATION de service déclenche le
  // défaut — donc le premier déploiement d'un service, jamais les suivants.
  // Passer les deux arguments explicitement supprime la question.
  const auth = spec.registryAuth;

  if (!existing) {
    if (auth) {
      await docker.createService(auth, serviceSpec(spec));
    } else {
      await docker.createService(serviceSpec(spec));
    }
    // Une création n'a PAS d'UpdateStatus — il n'y a pas eu de mise à jour.
    // readUpdateState rendrait donc la main immédiatement et on annoncerait un
    // déploiement réussi alors que le conteneur démarre encore : le service
    // passe running, mais Traefik répond 404 le temps que la task converge.
    // Sur une création, la convergence se lit sur les TASKS.
    await waitForRunningTask(docker, spec.serviceName);
    const state = await readUpdateState(docker, spec.serviceName);
    return { created: true, ...state };
  }

  const service = docker.getService(existing.ID);
  // Même forme à deux arguments qu'à la création, bien qu'`update` sache
  // extraire `opts.authconfig` : dépendre de cette différence-là, c'est
  // reproduire le défaut au prochain refactor.
  // `update` SAIT extraire `opts.authconfig` quand on l'appelle avec un seul
  // argument (c'est la branche `typeof opts === 'undefined'` de dockerode) —
  // contrairement à `createService`, qui laisse alors `auth` valoir la spec.
  // D'où les deux formes différentes ci-dessus et ici : chacune est celle qui
  // marche pour SA méthode, plutôt qu'une seule qui marcherait à moitié.
  await service.update({
    ...serviceSpec(spec),
    ...(auth ? { authconfig: auth } : {}),
    version: existing.Version?.Index,
  });

  const state = await readUpdateState(docker, spec.serviceName);
  return { created: false, ...state };
}

/**
 * Le nœud sur lequel une task du service tourne RÉELLEMENT.
 *
 * Tant que chaque image était locale, la question ne se posait pas : la
 * contrainte de placement donnait la réponse d'avance. Avec un registre, c'est
 * le planificateur Swarm qui choisit, et un tableau de bord qui continuerait
 * d'afficher le serveur de BUILD comme lieu d'exécution affirmerait quelque
 * chose de faux.
 *
 * Rend `null` plutôt qu'une valeur de repli quand aucune task ne tourne : un
 * trou reste un trou. « On ne sait pas où ça tourne » et « ça tourne sur le
 * serveur de build » sont deux affirmations différentes, et la seconde serait
 * inventée.
 */
export async function readRunningNodeId(
  docker: DockerApi,
  serviceName: string
): Promise<string | null> {
  const tasks = (await docker.listTasks({
    filters: JSON.stringify({ service: [serviceName] }),
  })) as unknown as Array<{
    NodeID?: string;
    Status?: { State?: string };
  }>;
  const running = tasks.find((t) => t.Status?.State === "running");
  return running?.NodeID ?? null;
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

/**
 * L'ID Swarm du nœud DERRIÈRE cette connexion — celui qui vient de construire
 * l'image, jamais celui qui reçoit la commande `docker service create/update`
 * quand les deux diffèrent.
 *
 * `docker info` est une lecture locale : un nœud worker y répond correctement
 * sur lui-même, contrairement à `docker service` ou `docker node`, réservés
 * au manager parce qu'ils lisent l'état répliqué du cluster.
 */
export async function getSwarmNodeId(docker: DockerApi): Promise<string> {
  const info = (await docker.info()) as { Swarm?: { NodeID?: string } };
  const nodeId = info.Swarm?.NodeID;
  if (!nodeId) {
    throw new Error("this node has no Swarm ID — did it join the cluster?");
  }
  return nodeId;
}
