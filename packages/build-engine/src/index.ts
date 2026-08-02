// Construction d'images sur le serveur cible.
//
// Tout ce fichier est la Phase 0 transposée en code. Chaque contrainte ci-
// dessous a coûté une exécution ratée ; aucune n'est théorique.
import {
  type ExecOptions,
  type ExecResult,
  exec,
  execArgv,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";

export class BuildError extends Error {
  readonly stage: string;
  readonly exitCode: number | null;

  constructor(stage: string, message: string, exitCode: number | null) {
    super(message);
    this.name = "BuildError";
    this.stage = stage;
    this.exitCode = exitCode;
  }
}

function check(stage: string, res: ExecResult): ExecResult {
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout)
      .trim()
      .split("\n")
      .slice(-8)
      .join("\n");
    throw new BuildError(
      stage,
      `${stage} a échoué (code ${res.code})\n${tail}`,
      res.code
    );
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimensionnement du plafond de build
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildCap {
  cpuPeriod: number;
  cpuQuota: number;
  memory: string;
}

/**
 * Dérive le plafond de la mémoire du serveur.
 *
 * Pas de la mémoire TOTALE : sous la topologie retenue, Noddle héberge aussi
 * son propre Postgres, Redis, web et worker sur la même machine, plus les
 * services déjà déployés. Un plafond calculé sur le total affamerait exactement
 * ce qu'il est censé protéger.
 *
 * La borne basse à 512 Mo n'est pas de la prudence : en dessous, un build Node
 * ordinaire échoue, et l'utilisateur conclut que Noddle est cassé plutôt que
 * que sa machine est trop petite.
 */
export function computeBuildCap(opts: {
  totalMemoryMb: number;
  reservedMb?: number;
  cpus?: number;
}): BuildCap {
  const reserved = opts.reservedMb ?? 768;
  const available = Math.max(opts.totalMemoryMb - reserved, 0);
  const memoryMb = Math.max(Math.floor(available * 0.75), 512);

  const cpus = opts.cpus ?? 1.5;
  return {
    cpuPeriod: 100_000,
    cpuQuota: Math.round(cpus * 100_000),
    memory: `${memoryMb}m`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder capé
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crée le builder buildx qui portera le plafond.
 *
 * `docker build --memory` NE FONCTIONNE PAS : BuildKit accepte le flag et
 * l'ignore (moby/buildkit#1362). Un plafond posé là est un no-op silencieux —
 * le pire des cas, puisque le build réussit et la protection paraît active.
 *
 * Le cgroup doit donc porter sur le BUILDER. Le driver docker-container fait
 * tourner buildkitd dans un conteneur, et ce conteneur accepte
 * memory / cpu-quota / cpu-period en --driver-opt.
 */
export async function ensureCappedBuilder(
  client: SshClient,
  name: string,
  cap: BuildCap,
  opts: ExecOptions = {}
): Promise<void> {
  const exists = await exec(
    client,
    `sudo docker buildx inspect ${quoteArg(name)}`
  );
  if (exists.code === 0) {
    return;
  }
  check(
    "création du builder",
    await execArgv(
      client,
      [
        "sudo",
        "docker",
        "buildx",
        "create",
        "--name",
        name,
        "--driver",
        "docker-container",
        "--driver-opt",
        `memory=${cap.memory}`,
        "--driver-opt",
        `cpu-quota=${cap.cpuQuota}`,
        "--driver-opt",
        `cpu-period=${cap.cpuPeriod}`,
        "--bootstrap",
      ],
      opts
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Récupération du code
// ─────────────────────────────────────────────────────────────────────────────

export interface CloneOptions extends ExecOptions {
  branch: string;
  commitSha?: string;
  dir: string;
  repoUrl: string;
}

/** Renvoie le SHA effectivement construit — jamais « la branche ». */
export async function fetchSource(
  client: SshClient,
  o: CloneOptions
): Promise<string> {
  check(
    "préparation du répertoire",
    await exec(
      client,
      `sudo rm -rf ${quoteArg(o.dir)} && sudo mkdir -p ${quoteArg(o.dir)} && sudo chown -R "$USER" ${quoteArg(o.dir)}`
    )
  );

  // execArgv : l'URL et la branche viennent de l'utilisateur. Concaténées telles
  // quelles dans une chaîne shell, elles exécutent du code sur SON serveur.
  check(
    "git clone",
    await execArgv(
      client,
      ["git", "clone", "--depth", "1", "--branch", o.branch, o.repoUrl, o.dir],
      o
    )
  );

  if (o.commitSha) {
    check(
      "git checkout",
      await execArgv(
        client,
        ["git", "-C", o.dir, "fetch", "--depth", "1", "origin", o.commitSha],
        o
      )
    );
    check(
      "git checkout",
      await execArgv(client, ["git", "-C", o.dir, "checkout", o.commitSha], o)
    );
  }

  const rev = check(
    "git rev-parse",
    await execArgv(client, ["git", "-C", o.dir, "rev-parse", "HEAD"])
  );
  return rev.stdout.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildOptions extends ExecOptions {
  builderName: string;
  dir: string;
  imageTag: string;
}

/**
 * Nixpacks génère le Dockerfile, buildx le construit sur le builder capé.
 *
 * Deux pièges, tous deux payés en Phase 0 :
 *
 * 1. `--out .` et jamais un autre répertoire. Nixpacks n'écrit QUE `.nixpacks/`
 *    et ne copie pas les sources, alors que le Dockerfile généré fait
 *    `COPY .nixpacks/…`. Sorti ailleurs, le contexte ne contient pas ce COPY.
 *
 * 2. JAMAIS `--apt` ni `--pkgs`. Sur nixpacks 1.41, les deux écrasent la liste
 *    d'overlays nix, où le provider Node déclare nix-npm-overlay — qui DÉFINIT
 *    npm-9_x. Sans elle, tout build Node meurt sur
 *    `error: undefined variable 'npm-9_x'`. Il n'existe donc aucun moyen
 *    d'injecter un paquet par la CLI : ce dont l'image a besoin doit venir de
 *    l'image de base.
 */
export async function buildImage(
  client: SshClient,
  o: BuildOptions
): Promise<void> {
  check(
    "nixpacks",
    await exec(
      client,
      `cd ${quoteArg(o.dir)} && rm -rf .nixpacks && nixpacks build . --out .`,
      o
    )
  );

  check(
    "vérification du plan nixpacks",
    await exec(client, `test -f ${quoteArg(`${o.dir}/.nixpacks/Dockerfile`)}`)
  );

  // --progress=plain : le renderer TTY par défaut de buildx réécrit l'écran et
  // est inexploitable en flux SSE. C'est cette sortie-là qui part au dashboard.
  check(
    "docker buildx build",
    await exec(
      client,
      `cd ${quoteArg(o.dir)} && sudo docker buildx build` +
        ` --builder ${quoteArg(o.builderName)}` +
        " --progress=plain --load" +
        " -f .nixpacks/Dockerfile" +
        ` -t ${quoteArg(o.imageTag)} .`,
      o
    )
  );
}
