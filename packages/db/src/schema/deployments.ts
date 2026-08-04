import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "#schema/columns";
import { services } from "#schema/services";

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

    // Le nœud Swarm sur lequel la task tourne RÉELLEMENT, relevé après
    // convergence — pas celui qu'on avait demandé.
    //
    // Tant que chaque image était locale à son nœud, la question ne se posait
    // pas : `services.server_id` était à la fois là où ça se construisait et
    // là où ça tournait. Avec un registre, l'image est portable et c'est le
    // planificateur Swarm qui choisit. `server_id` ne veut donc plus dire que
    // « là où ça se construit », et un tableau de bord qui continuerait de
    // l'afficher comme lieu d'exécution affirmerait quelque chose de faux.
    //
    // NULL pour tout déploiement d'avant le registre, et pour tout déploiement
    // dont aucune task ne tourne : un trou reste un trou, il ne se comble pas
    // avec le serveur de build « à défaut ».
    nodeId: text("node_id"),

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
