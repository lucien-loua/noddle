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
const HTTP_OR_HTTPS_URL = /^https?:\/\//;
const LEADING_SLASHES = /^\/+/;
const TRAILING_SLASHES = /\/+$/;

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

// ─────────────────────────────────────────────────────────────────────────────
// sauvegardes vers S3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Les règles d'AWS, pas les nôtres : 3 à 63 caractères, minuscules, chiffres,
 * points et tirets, commençant et finissant par un alphanumérique. Un
 * compartiment en majuscules est refusé par le service, donc autant le dire
 * dans le formulaire plutôt qu'à la première sauvegarde.
 */
export const bucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/,
    "minuscules, chiffres, points et tirets ; doit commencer et finir par un alphanumérique"
  );

/**
 * Préfixe de clé. Optionnel, et normalisé sans `/` initial ni final : il est
 * recollé avec un séparateur explicite au moment de construire la clé, et
 * deux sources de vérité sur qui pose la barre obliquent produisent des clés
 * `noddle//base/…`.
 */
export const objectPrefixSchema = z
  .string()
  .max(256)
  .regex(
    /^[a-zA-Z0-9!\-_.*'()/]*$/,
    "caractères sûrs pour une clé S3 uniquement"
  )
  .refine((v) => !v.includes(".."), "`..` interdit dans un préfixe")
  .transform((v) =>
    v.replace(LEADING_SLASHES, "").replace(TRAILING_SLASHES, "")
  );

export const backupDestinationSchema = z.object({
  accessKeyId: z.string().min(1).max(128),
  bucket: bucketNameSchema,
  endpoint: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (v) => HTTP_OR_HTTPS_URL.test(v),
      "URL http:// ou https:// du service S3 attendue"
    ),
  // Vrai partout sauf sur le S3 d'Amazon lui-même : `compartiment.hôte` ne
  // résout pas pour RustFS, MinIO ou une instance jointe par IP.
  forcePathStyle: z.boolean().default(true),
  prefix: objectPrefixSchema.default(""),
  // Entre dans le calcul de la signature SigV4 : une région fausse fait
  // échouer l'authentification, même sur une implémentation qui l'ignore par
  // ailleurs.
  region: z.string().min(1).max(64).default("us-east-1"),
  secretAccessKey: z.string().min(1).max(256),
});

export type BackupDestinationInput = z.infer<typeof backupDestinationSchema>;

export const backupRequestSchema = z.object({
  databaseId: z.uuid(),
});

export type BackupRequest = z.infer<typeof backupRequestSchema>;

/**
 * Restaurer est la SEULE opération irréversible du produit : elle écrase les
 * données courantes, là où rejouer une image ne détruit rien.
 *
 * `confirmName` porte cette différence jusqu'au serveur. Une boîte de dialogue
 * qui demande de taper le nom ne protège que les clients qui l'affichent ;
 * exiger le nom ICI fait que le garde-fou existe pour de bon, quel que soit
 * l'appelant. `databaseId` est demandé pour la même raison : il est déductible
 * de la sauvegarde, mais le fournir permet de refuser une restauration croisée
 * plutôt que de la découvrir après coup.
 */
// ─────────────────────────────────────────────────────────────────────────────
// notifications
// ─────────────────────────────────────────────────────────────────────────────

export const notificationKindSchema = z.enum(["webhook", "discord", "slack"]);

/**
 * L'URL d'un canal.
 *
 * `http` est accepté, `https` exigé pour Discord et Slack. Ces URL sont des
 * secrets porteurs — qui les détient peut écrire dans le salon — donc les
 * faire voyager en clair n'est pas anodin. Mais un webhook maison sur un
 * service interne (`http://10.0.0.5:5678`) est un cas légitime et fréquent en
 * auto-hébergé ; l'interdire ne sécuriserait personne, ça pousserait à
 * contourner Noddle.
 */
export const notificationUrlSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => HTTP_OR_HTTPS_URL.test(v), "URL http:// ou https:// attendue");

/**
 * Discord et Slack ne servent QUE du https : une URL `http` chez eux n'est pas
 * un choix d'infrastructure, c'est une faute de frappe qui échouerait au
 * premier envoi. On la refuse dans le formulaire plutôt qu'au moment où une
 * alerte devait partir.
 */
function hostedChannelIsHttps(data: {
  kind: "discord" | "slack" | "webhook";
  url?: string;
}): boolean {
  if (data.kind === "webhook" || !data.url) {
    return true;
  }
  return HTTPS_URL.test(data.url);
}

const HOSTED_HTTPS_MESSAGE =
  "Discord et Slack n'acceptent que des URL https://";

export const notificationChannelSchema = z
  .object({
    kind: notificationKindSchema,
    name: z.string().min(1).max(64),
    notifySuccess: z.boolean().default(false),
    url: notificationUrlSchema,
  })
  .refine(hostedChannelIsHttps, HOSTED_HTTPS_MESSAGE);

export type NotificationChannelInput = z.infer<
  typeof notificationChannelSchema
>;

/**
 * Modification d'un canal existant. L'URL est optionnelle : elle ne ressort
 * jamais du serveur — même règle que la clé secrète S3 et le mot de passe
 * d'une base — donc la laisser vide veut dire « garde celle d'avant ».
 */
export const notificationChannelUpdateSchema = z
  .object({
    channelId: z.uuid(),
    enabled: z.boolean(),
    kind: notificationKindSchema,
    name: z.string().min(1).max(64),
    notifySuccess: z.boolean(),
    url: notificationUrlSchema.optional(),
  })
  .refine(hostedChannelIsHttps, HOSTED_HTTPS_MESSAGE);

export type NotificationChannelUpdate = z.infer<
  typeof notificationChannelUpdateSchema
>;

export const notificationChannelIdSchema = z.object({ channelId: z.uuid() });

export const backupScheduleSchema = z.enum(["off", "daily", "weekly"]);

/**
 * Le réglage automatique d'une base.
 *
 * La rétention est bornée en haut ET en bas : à 0 on effacerait la sauvegarde
 * qu'on vient de prendre, et au-delà d'une centaine on ne garde plus une
 * histoire mais une facture de stockage que personne ne relit.
 */
export const backupScheduleRequestSchema = z.object({
  databaseId: z.uuid(),
  retention: z.number().int().min(1).max(100),
  schedule: backupScheduleSchema,
});

export type BackupScheduleRequest = z.infer<typeof backupScheduleRequestSchema>;

export const restoreRequestSchema = z.object({
  backupId: z.uuid(),
  confirmName: z.string().min(1).max(48),
  databaseId: z.uuid(),
});

export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

/**
 * Supprimer un service est irréversible : l'historique, les images et les
 * variables partent avec lui. Même exigence qu'une restauration, donc —
 * `confirmName` porte le nom saisi jusqu'au SERVEUR, qui le revérifie. Une
 * boîte de dialogue ne protège que les clients qui l'affichent.
 */
export const deleteServiceSchema = z.object({
  confirmName: z.string().min(1).max(48),
  serviceId: z.uuid(),
});

export type DeleteServiceRequest = z.infer<typeof deleteServiceSchema>;

export const serviceMetricsRequestSchema = z.object({ serviceId: z.uuid() });

// ─────────────────────────────────────────────────────────────────────────────
// comptes
// ─────────────────────────────────────────────────────────────────────────────

export const accountRoleNameSchema = z.enum([
  "owner",
  "admin",
  "deployer",
  "viewer",
]);

export const createAccountSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(64),
  role: accountRoleNameSchema,
});

export const accountRoleSchema = z.object({
  role: accountRoleNameSchema,
  userId: z.string().min(1),
});

export const accountIdSchema = z.object({ userId: z.string().min(1) });
