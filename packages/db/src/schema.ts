// Schéma Drizzle — Phase 1 uniquement.
//
// Ce qui n'y est PAS, volontairement : backups, notifications_config, teams/RBAC.
// Ce sont des tables de Phase 3, et CLAUDE.md interdit de préparer des fichiers
// « pour plus tard ». Les tables d'authentification ne sont pas ici non plus :
// better-auth génère les siennes.
import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

// ─────────────────────────────────────────────────────────────────────────────
// servers
// ─────────────────────────────────────────────────────────────────────────────

export const serverStatus = pgEnum("server_status", [
  "pending",
  "connected",
  "unreachable",
]);

export const servers = pgTable(
  "servers",
  {
    createdAt,

    // La version d'API Docker minimale du daemon, relevée à la connexion.
    // Traefik < 3.6 parle l'API 1.24 et Docker 29 la refuse : c'est ce couple
    // qui a cassé la Phase 0, et Noddle installe les deux côtés.
    dockerApiMinVersion: text("docker_api_min_version"),
    dockerVersion: text("docker_version"),
    host: text("host").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),

    // La machine qui héberge Noddle est enregistrée comme serveur cible n°1.
    // AFFICHAGE UNIQUEMENT — ne jamais brancher le code dessus. La cible locale
    // passe par l'exécuteur SSH comme n'importe quelle autre, précisément pour
    // que ce chemin soit exercé par tous les utilisateurs mono-machine.
    isSelf: boolean("is_self").notNull().default(false),
    name: text("name").notNull(),
    sshPort: integer("ssh_port").notNull().default(22),

    // AES-256-GCM, clé dérivée de APP_KEY. Ne jamais journaliser la valeur
    // déchiffrée, ni la renvoyer par une server function.
    sshPrivateKeyEncrypted: text("ssh_private_key_encrypted").notNull(),
    sshUser: text("ssh_user").notNull(),

    status: serverStatus("status").notNull().default("pending"),

    // Mémoire totale relevée sur la machine. Le plafond de build s'en déduit,
    // en tenant compte de ce que consomme déjà le plan de contrôle.
    totalMemoryMb: integer("total_memory_mb"),
    updatedAt,
  },
  (t) => [
    uniqueIndex("servers_host_port_user_idx").on(t.host, t.sshPort, t.sshUser),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// projects / environments
// ─────────────────────────────────────────────────────────────────────────────

export const projects = pgTable("projects", {
  createdAt,
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  updatedAt,
});

export const environments = pgTable(
  "environments",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    updatedAt,
  },
  (t) => [uniqueIndex("environments_project_name_idx").on(t.projectId, t.name)]
);

// ─────────────────────────────────────────────────────────────────────────────
// services
// ─────────────────────────────────────────────────────────────────────────────

export const sourceType = pgEnum("source_type", [
  "git",
  "docker_image",
  "compose",
]);

export const buildMethod = pgEnum("build_method", [
  "nixpacks",
  "dockerfile",
  "image",
]);

export const serviceStatus = pgEnum("service_status", [
  "created",
  "deploying",
  "running",
  "stopped",
  "crashed",
]);

export const services = pgTable(
  "services",
  {
    buildMethod: buildMethod("build_method").notNull().default("nixpacks"),

    createdAt,

    // Déploiement actuellement servi. Sert au rollback : Noddle rejoue une image
    // depuis SON historique, alors que Swarm ne conserve qu'une spec précédente.
    currentDeploymentId: uuid("current_deployment_id"),
    domain: text("domain"),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    gitBranch: text("git_branch"),
    gitRepoUrl: text("git_repo_url"),
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(),
    port: integer("port").notNull().default(3000),

    // Les images construites localement n'existent que sur la machine qui les a
    // produites : Swarm ne peut pas déplacer le service ailleurs. Le lien vers
    // le serveur est donc structurel, pas un simple placement.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    sourceType: sourceType("source_type").notNull(),
    status: serviceStatus("status").notNull().default("created"),
    updatedAt,
  },
  (t) => [
    uniqueIndex("services_env_name_idx").on(t.environmentId, t.name),
    index("services_server_idx").on(t.serverId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// env_vars
// ─────────────────────────────────────────────────────────────────────────────

export const envVars = pgTable(
  "env_vars",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),

    // Pilote l'affichage (masquée dans l'UI) et l'injection : préférer
    // `docker secret` pour que rien ne fuite dans `docker inspect`.
    isSecret: boolean("is_secret").notNull().default(false),
    key: text("key").notNull(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    updatedAt,

    // Chiffré au repos, systématiquement — y compris pour les valeurs non
    // secrètes. Un seul chemin de code, donc aucun risque d'oubli.
    valueEncrypted: text("value_encrypted").notNull(),
  },
  (t) => [uniqueIndex("env_vars_service_key_idx").on(t.serviceId, t.key)]
);

// ─────────────────────────────────────────────────────────────────────────────
// deployments
// ─────────────────────────────────────────────────────────────────────────────

export const deploymentStatus = pgEnum("deployment_status", [
  "queued",
  "building",
  "deploying",
  // Converge et sert le trafic. La surveillance post-déploiement tourne encore.
  "succeeded",
  "failed",
  // Swarm a refusé la bascule : le health gate a joué, l'ancienne version sert.
  "rolled_back",
  // A convergé PUIS s'est mis à redémarrer en boucle après la fenêtre monitor.
  // Distinct de `failed` : ici le déploiement avait réussi, et c'est Noddle qui
  // a repris la main. Cf. CLAUDE.md, mesuré en Phase 0.
  "reverted_by_watch",
]);

export const deploymentTrigger = pgEnum("deployment_trigger", [
  "manual",
  "webhook",
  "rollback",
  "watch_revert",
]);

export const deployments = pgTable(
  "deployments",
  {
    commitSha: text("commit_sha"),

    createdAt,

    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),

    // Le tag exact construit et déployé. C'est LA colonne qui rend le rollback
    // possible vers n'importe quelle version, pas seulement la précédente.
    imageTag: text("image_tag"),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),

    startedAt: timestamp("started_at", { withTimezone: true }),

    status: deploymentStatus("status").notNull().default("queued"),

    // `docker service update` renvoie 0 même après un rollback : l'état réel
    // n'est lisible que dans UpdateStatus.State. On le stocke tel quel plutôt
    // que de le déduire d'un code de sortie.
    swarmUpdateState: text("swarm_update_state"),
    trigger: deploymentTrigger("trigger").notNull().default("manual"),

    // Jusqu'à quand la surveillance post-déploiement observe le service. La
    // garantie de Swarm expire avec --update-monitor ; celle-ci prend le relais.
    watchUntil: timestamp("watch_until", { withTimezone: true }),
  },
  (t) => [index("deployments_service_created_idx").on(t.serviceId, t.createdAt)]
);

// ─────────────────────────────────────────────────────────────────────────────
// deployment_logs — POINTEUR, jamais le texte
// ─────────────────────────────────────────────────────────────────────────────

export const deploymentLogs = pgTable(
  "deployment_logs",
  {
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),

    createdAt,
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().defaultRandom(),

    // Chemin disque ou URL objet. Le texte des logs part en SSE vers le
    // dashboard et se persiste à côté. JAMAIS une ligne Postgres par ligne de
    // log : un build Next.js en produit des dizaines de milliers.
    storageUrl: text("storage_url").notNull(),
  },
  (t) => [index("deployment_logs_deployment_idx").on(t.deploymentId)]
);

// ─────────────────────────────────────────────────────────────────────────────
// relations
// ─────────────────────────────────────────────────────────────────────────────

export const projectsRelations = relations(projects, ({ many }) => ({
  environments: many(environments),
}));

export const environmentsRelations = relations(
  environments,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [environments.projectId],
      references: [projects.id],
    }),
    services: many(services),
  })
);

export const serversRelations = relations(servers, ({ many }) => ({
  services: many(services),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  deployments: many(deployments),
  environment: one(environments, {
    fields: [services.environmentId],
    references: [environments.id],
  }),
  envVars: many(envVars),
  server: one(servers, {
    fields: [services.serverId],
    references: [servers.id],
  }),
}));

export const envVarsRelations = relations(envVars, ({ one }) => ({
  service: one(services, {
    fields: [envVars.serviceId],
    references: [services.id],
  }),
}));

export const deploymentsRelations = relations(deployments, ({ one, many }) => ({
  logs: many(deploymentLogs),
  service: one(services, {
    fields: [deployments.serviceId],
    references: [services.id],
  }),
}));

export const deploymentLogsRelations = relations(deploymentLogs, ({ one }) => ({
  deployment: one(deployments, {
    fields: [deploymentLogs.deploymentId],
    references: [deployments.id],
  }),
}));
