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

export type ServiceInput = z.infer<typeof serviceInputSchema>;

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
