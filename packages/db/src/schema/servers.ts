import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";

export const serverStatus = pgEnum("server_status", [
  "pending",
  "connected",
  "unreachable",
]);

/**
 * Rôle Swarm — orthogonal à `isSelf`.
 *
 * `docker service create/update` refuse sur un nœud worker : seul un manager
 * répond à ces appels, parce que c'est lui qui détient l'état répliqué du
 * cluster. Un build local, lui, ne laisse l'image que sur le nœud qui l'a
 * construite — d'où la contrainte de placement qui épingle chaque service à
 * SON nœud, indépendamment de celui qui reçoit la commande Swarm.
 *
 * Un seul manager en Phase 2, volontairement : au-delà, la taille du quorum
 * Raft devient une décision opérationnelle à part entière (rester impair),
 * hors du périmètre retenu ici.
 */
export const serverRole = pgEnum("server_role", ["manager", "worker"]);

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
    //
    // `role`, ci-dessous, est le champ qui porte le fait d'orchestration :
    // deux colonnes indépendantes, même si en Phase 2 c'est TOUJOURS la
    // machine isSelf qui est aussi le manager — parce qu'elle seule a lancé
    // `docker swarm init`, jamais parce que le code l'aurait déduit d'isSelf.
    isSelf: boolean("is_self").notNull().default(false),

    // Pourquoi une installation a échoué à rejoindre, visible sans fouiller
    // les journaux du worker. `status` seul dit QUOI (pending/unreachable),
    // pas POURQUOI.
    lastError: text("last_error"),
    name: text("name").notNull(),
    role: serverRole("role").notNull().default("worker"),
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
