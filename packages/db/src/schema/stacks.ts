// Un déploiement Docker Compose : plusieurs conteneurs sous un même nom,
// posés par `docker stack deploy` — jamais une boucle de `docker service
// create` maison, pour la même raison que le chemin mono-service existant :
// laisser Swarm traduire une syntaxe compose arbitraire (volumes, réseaux,
// réplicas) plutôt que la réimplémenter.
//
// `stacks` reste volontairement plus pauvre que `services` : un seul serveur
// (une image construite localement n'existe que sur ce nœud, comme pour
// `services`), et AU PLUS un sous-service public (`publicService` + `domain` +
// `port`). Les autres conteneurs de la pile (un worker, un Redis à soi) ne
// reçoivent pas de route Traefik — c'est le cas courant que Compose sert :
// app + à-côtés, pas N domaines par pile.
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";
import { deploymentStatus, deploymentTrigger } from "#schema/deployments";
import { environments } from "#schema/projects";
import { servers } from "#schema/servers";
import { serviceStatus } from "#schema/services";

export const stacks = pgTable(
  "stacks",
  {
    composeFilePath: text("compose_file_path")
      .notNull()
      .default("docker-compose.yml"),
    createdAt,

    // Le déploiement actuellement servi — même rôle que
    // `services.currentDeploymentId` : permet le rollback vers n'importe
    // quelle version de l'historique, pas seulement la précédente.
    currentDeploymentId: uuid("current_deployment_id"),
    domain: text("domain"),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    gitBranch: text("git_branch").notNull().default("main"),
    gitRepoUrl: text("git_repo_url").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(),
    port: integer("port"),

    // La clé du service, DANS le fichier compose, qui reçoit la route
    // Traefik. Absente = pile sans surface publique (une file pure, par
    // exemple) : légitime, pas une donnée manquante.
    publicService: text("public_service"),

    // Comme `services.serverId` : le lien est structurel, pas un simple
    // placement — Swarm ne peut pas déplacer une image qui n'existe que sur
    // le nœud qui l'a construite.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    status: serviceStatus("status").notNull().default("created"),
    updatedAt,
  },
  (t) => [
    uniqueIndex("stacks_env_name_idx").on(t.environmentId, t.name),
    index("stacks_server_idx").on(t.serverId),
  ]
);

export const stackDeployments = pgTable(
  "stack_deployments",
  {
    commitSha: text("commit_sha"),

    // Le YAML tel que lu dans le dépôt, AVANT réécriture des `build:` en
    // `image:`. Un rollback rejoue CETTE version texte avec les tags déjà
    // enregistrés — aucun accès réseau ni au dépôt git ni à un nouveau build,
    // exactement le principe qui rend `redeployImage` instantané.
    composeSource: text("compose_source"),

    createdAt,
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),

    // Un tag par service compose que NODDLE a construit (ceux avec `build:`).
    // Les services qui ne font que `image:` n'y figurent pas : rien à
    // rejouer, ils pointent toujours vers la même image externe.
    serviceImages: jsonb("service_images").$type<Record<string, string>>(),

    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: deploymentStatus("status").notNull().default("queued"),

    // Un état par service Swarm résultant, jamais un seul agrégat : `docker
    // stack deploy` rend la main avant convergence, exactement comme `docker
    // service update` — la même prudence sur le code de sortie s'applique,
    // multipliée par le nombre de conteneurs de la pile.
    swarmUpdateStates: jsonb("swarm_update_states").$type<
      Record<string, string | null>
    >(),
    trigger: deploymentTrigger("trigger").notNull().default("manual"),

    // Comme `deployments.watchUntil` : la garantie de Swarm expire avec sa
    // fenêtre monitor, la surveillance de Noddle prend le relais.
    watchUntil: timestamp("watch_until", { withTimezone: true }),
  },
  (t) => [
    index("stack_deployments_stack_created_idx").on(t.stackId, t.createdAt),
  ]
);

export const stackDeploymentLogs = pgTable(
  "stack_deployment_logs",
  {
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    stackDeploymentId: uuid("stack_deployment_id")
      .notNull()
      .references(() => stackDeployments.id, { onDelete: "cascade" }),

    // Chemin disque ou URL objet, jamais une ligne Postgres par ligne de log
    // — même raison que `deploymentLogs`.
    storageUrl: text("storage_url").notNull(),
  },
  (t) => [index("stack_deployment_logs_deployment_idx").on(t.stackDeploymentId)]
);
