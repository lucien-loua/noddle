// Échantillons de ressources : ce que consomment les machines et les services.
//
// Une ligne Postgres par échantillon, ce qui contredit en apparence la règle
// « jamais une ligne par ligne de log ». La différence est d'ordre de
// grandeur : un build Next.js produit des dizaines de milliers de lignes de
// log en quelques minutes, là où un échantillon par minute et par ressource
// fait 1440 lignes par jour. Dix services sur sept jours tiennent dans
// 100 000 lignes — Postgres n'y voit rien.
//
// Au-delà de sept jours il faudrait agréger, donc une vraie base temporelle,
// donc une dépendance et une décision d'architecture que ce chantier n'a pas
// à ouvrir. La rétention est courte et assumée.
import {
  bigint,
  index,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { servers } from "#schema/servers";
import { services } from "#schema/services";

/**
 * L'état d'une machine à un instant.
 *
 * Aucune colonne n'est nullable par commodité : une valeur absente doit
 * empêcher l'écriture de la ligne, pas produire un échantillon à moitié vide.
 * **Un trou dans la série veut dire « on ne regardait pas », et c'est une
 * information** — la confondre avec un zéro ferait croire qu'une machine
 * allait bien pendant qu'elle était injoignable.
 */
export const serverMetrics = pgTable(
  "server_metrics",
  {
    /** Nombre de cœurs, pour que la charge soit interprétable sans deviner. */
    cpuCount: bigint("cpu_count", { mode: "number" }).notNull(),
    /** Charge moyenne sur 1 minute, telle que la rend `/proc/loadavg`. */
    cpuLoad1: real("cpu_load1").notNull(),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }).notNull(),
    diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    memoryTotalBytes: bigint("memory_total_bytes", {
      mode: "number",
    }).notNull(),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }).notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
  },
  // L'index porte sur (serveur, instant) : toutes les lectures sont « la
  // dernière fenêtre de CE serveur », jamais un balayage global.
  (t) => [index("server_metrics_server_time_idx").on(t.serverId, t.sampledAt)]
);

/**
 * L'état d'un service à un instant.
 *
 * `memoryLimitBytes` peut valoir 0 : un conteneur sans limite déclarée est
 * borné par la machine. On stocke ce que Docker rend plutôt que de substituer
 * la mémoire de l'hôte, pour que « sans limite » reste lisible comme tel.
 */
export const serviceMetrics = pgTable(
  "service_metrics",
  {
    /** Pourcentage d'UN cœur, comme le calcule `docker stats`. */
    cpuPercent: real("cpu_percent").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    memoryLimitBytes: bigint("memory_limit_bytes", {
      mode: "number",
    }).notNull(),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }).notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),

    /**
     * Le nom de la task Swarm échantillonnée.
     *
     * Gardé parce qu'un service redéployé change de conteneur : sans lui, une
     * chute brutale de mémoire se lit comme une fuite corrigée alors que
     * c'est simplement une nouvelle task qui démarre.
     */
    taskName: text("task_name").notNull(),
  },
  (t) => [
    index("service_metrics_service_time_idx").on(t.serviceId, t.sampledAt),
  ]
);
