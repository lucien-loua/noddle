import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";
import { environments } from "#schema/projects";
import { servers } from "#schema/servers";

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
  // Le démontage est en cours : le service Swarm doit disparaître AVANT la
  // ligne, sinon Traefik continuerait de router vers une application que
  // l'utilisateur croit supprimée — un mensonge plus grave que l'inverse.
  //
  // Un service qui reste ici est un démontage qui a échoué, pas un état
  // stable. Le geste est rejouable : `removeService` et la purge du registre
  // sont idempotents.
  "deleting",
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

    // Absent = pas de webhook configuré. Présent une seule fois en clair, au
    // moment de sa génération — jamais relu ensuite, même chiffré : le
    // formulaire ne peut que le régénérer, exactement comme un jeton d'API.
    webhookSecretEncrypted: text("webhook_secret_encrypted"),
  },
  (t) => [
    uniqueIndex("services_env_name_idx").on(t.environmentId, t.name),
    index("services_server_idx").on(t.serverId),
  ]
);
