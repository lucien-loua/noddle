// Schémas Zod partagés client/serveur.
//
// La validation n'est pas la protection contre l'injection — c'est `execArgv`
// dans @noddle/ssh-executor qui s'en charge, en échappant chaque argument. Ici
// on refuse en amont ce qui n'a aucune raison d'être valide, pour que l'erreur
// arrive dans un formulaire plutôt qu'au milieu d'un déploiement.
import { z } from "zod";

// Hissées au niveau module : une regex reconstruite à chaque appel se
// recompile à chaque validation.
const BRANCH_FORBIDDEN_CHARS = /[\s~^:?*[\\]/;
const GIT_SSH_URL = /^git@[\w.-]+:/;
const HTTPS_URL = /^https:\/\//;

// ─────────────────────────────────────────────────────────────────────────────
// serveurs
// ─────────────────────────────────────────────────────────────────────────────

export const sshPrivateKeySchema = z
  .string()
  .min(1, "clé requise")
  .refine(
    (v) => v.includes("-----BEGIN") && v.includes("PRIVATE KEY"),
    "ce n'est pas une clé privée PEM — attention à ne pas coller la clé publique (.pub)"
  );

export const serverInputSchema = z.object({
  host: z.string().min(1).max(255),
  name: z.string().min(1).max(64),
  privateKey: sshPrivateKeySchema,
  sshPort: z.number().int().min(1).max(65_535).default(22),
  sshUser: z.string().min(1).max(32),
});

export type ServerInput = z.infer<typeof serverInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// projets / environnements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple étiquette d'organisation, jamais un identifiant Docker ou Traefik —
 * contrairement au nom de service, elle n'a donc pas besoin d'être en
 * minuscules ni de suivre les contraintes d'un nom d'hôte.
 */
export const projectNameSchema = z.string().min(1).max(64);
export const environmentNameSchema = z.string().min(1).max(64);

// ─────────────────────────────────────────────────────────────────────────────
// services
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le nom devient un nom de service Swarm et un nom de routeur Traefik. Les deux
 * n'acceptent pas n'importe quoi, et un nom refusé ne doit pas se découvrir au
 * moment du déploiement.
 */
export const serviceNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "minuscules, chiffres et tirets ; ne peut pas commencer ni finir par un tiret"
  );

export const gitRepoUrlSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (v) => HTTPS_URL.test(v) || GIT_SSH_URL.test(v),
    "URL https:// ou git@hôte:chemin attendue"
  );

export const gitBranchSchema = z
  .string()
  .min(1)
  .max(255)
  // Les restrictions de git lui-même : pas d'espace, pas de `..`, pas de `~^:?*[`,
  // pas de fin en `.lock`. Une branche invalide fait échouer le clone.
  .refine(
    (v) => !BRANCH_FORBIDDEN_CHARS.test(v),
    "caractère interdit dans un nom de branche"
  )
  .refine((v) => !v.includes(".."), "`..` interdit dans un nom de branche")
  .refine(
    (v) => !v.endsWith(".lock"),
    "un nom de branche ne peut pas finir par .lock"
  );

export const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    "nom de domaine invalide"
  );

export const serviceInputSchema = z.object({
  buildMethod: z.enum(["nixpacks", "dockerfile", "image"]).default("nixpacks"),
  domain: domainSchema.optional(),
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema.optional(),
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).default(3000),
  sourceType: z.enum(["git", "docker_image", "compose"]),
});

/**
 * « Connecter un dépôt » — le seul chemin de déploiement que le worker sache
 * réellement exécuter aujourd'hui : dépôt git, build nixpacks. `sourceType`
 * n'est donc pas un choix ici, contrairement à `serviceInputSchema` : proposer
 * `docker_image` ou `compose` dans un formulaire avant que le worker sache les
 * construire ferait miroiter une fonctionnalité qui échouerait au premier
 * déploiement.
 */
export const connectRepoSchema = z.object({
  domain: domainSchema.optional(),
  environmentName: environmentNameSchema,
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema,
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).default(3000),
  projectName: projectNameSchema,
  serverId: z.uuid(),
});

export type ConnectRepoInput = z.infer<typeof connectRepoSchema>;

export type ServiceInput = z.infer<typeof serviceInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// piles Compose
// ─────────────────────────────────────────────────────────────────────────────

/** Même contrainte que le nom d'un service compose côté worker : ce qui suit
 *  devient `${nomDePile}_${clé}` en nom de service Swarm. */
const composeServiceKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "clé de service compose invalide");

const composeFilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?!\/)(?!.*\.\.)[\w./-]+$/,
    "chemin relatif attendu, sans évasion du dépôt"
  )
  .default("docker-compose.yml");

/**
 * « Connecter un dépôt Compose » — comme `connectRepoSchema`, mais pour
 * plusieurs conteneurs sous un même nom. AU PLUS un service reçoit une route
 * Traefik (`publicService` + `domain` + `port`) : c'est le cas courant que
 * Compose sert (app + à-côtés), pas N domaines par pile.
 */
export const connectStackSchema = z
  .object({
    composeFilePath: composeFilePathSchema,
    domain: domainSchema.optional(),
    environmentName: environmentNameSchema,
    gitBranch: gitBranchSchema.default("main"),
    gitRepoUrl: gitRepoUrlSchema,
    name: serviceNameSchema,
    port: z.number().int().min(1).max(65_535).optional(),
    projectName: projectNameSchema,
    publicService: composeServiceKeySchema.optional(),
    serverId: z.uuid(),
  })
  .refine((v) => !v.publicService || v.port !== undefined, {
    message: "un port est requis pour exposer un service",
    path: ["port"],
  });

export type ConnectStackInput = z.infer<typeof connectStackSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// variables d'environnement
// ─────────────────────────────────────────────────────────────────────────────

export const envVarKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "identifiant shell attendu : lettres, chiffres et _ , ne commence pas par un chiffre"
  );

export const envVarInputSchema = z.object({
  isSecret: z.boolean().default(false),
  key: envVarKeySchema,
  // Une valeur peut légitimement être vide, et contenir n'importe quoi. C'est
  // `execArgv` qui la rend inoffensive, pas cette validation.
  value: z.string().max(65_536),
});

export type EnvVarInput = z.infer<typeof envVarInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// déploiements
// ─────────────────────────────────────────────────────────────────────────────

export const deployRequestSchema = z.object({
  /** Absent = HEAD de la branche configurée. */
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "SHA de commit invalide")
    .optional(),
  serviceId: z.uuid(),
});

export type DeployRequest = z.infer<typeof deployRequestSchema>;

export const rollbackRequestSchema = z.object({
  /**
   * Le déploiement vers lequel revenir. Explicite, pas « le précédent » :
   * Noddle conserve tout l'historique et peut viser n'importe quelle version,
   * là où Swarm ne garde qu'une spec antérieure.
   */
  deploymentId: z.uuid(),
  serviceId: z.uuid(),
});

export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

export const stackDeployRequestSchema = z.object({
  stackId: z.uuid(),
});

export type StackDeployRequest = z.infer<typeof stackDeployRequestSchema>;

export const stackRollbackRequestSchema = z.object({
  /** Le `stack_deployments` vers lequel revenir — même principe que
   *  `rollbackRequestSchema`, un par pile plutôt que par service. */
  sourceDeploymentId: z.uuid(),
  stackId: z.uuid(),
});

export type StackRollbackRequest = z.infer<typeof stackRollbackRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// bases de données en un clic
// ─────────────────────────────────────────────────────────────────────────────

export const databaseEngineSchema = z.enum(["postgres", "redis"]);

/**
 * « Connecter une base de données » — comme `connectRepoSchema`/
 * `connectStackSchema` : retrouve-ou-crée projet et environnement par nom.
 * Pas de champ pour le mot de passe : Noddle le génère, il n'est jamais saisi
 * ni affiché.
 */
export const connectDatabaseSchema = z.object({
  engine: databaseEngineSchema,
  environmentName: environmentNameSchema,
  name: serviceNameSchema,
  projectName: projectNameSchema,
  serverId: z.uuid(),
});

export type ConnectDatabaseInput = z.infer<typeof connectDatabaseSchema>;

/**
 * Écrit la chaîne de connexion directement comme variable d'environnement du
 * service choisi — jamais renvoyée au client. `envVarKey` a une valeur par
 * défaut proposée côté UI (`DATABASE_URL`/`REDIS_URL`) mais reste un choix de
 * l'utilisateur, pour ne pas entrer en conflit avec une variable déjà posée.
 */
export const attachDatabaseSchema = z.object({
  databaseId: z.uuid(),
  envVarKey: envVarKeySchema,
  serviceId: z.uuid(),
});

export type AttachDatabaseInput = z.infer<typeof attachDatabaseSchema>;
