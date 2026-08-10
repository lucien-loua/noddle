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
import { sshKeys } from "#schema/ssh-keys";

export const serverStatus = pgEnum("server_status", [
  "pending",
  "connected",
  "unreachable",
]);

/**
 * Swarm role — orthogonal to `isSelf`.
 *
 * `docker service create/update` refuses on a worker node: only a manager
 * answers those calls, because it's the one holding the cluster's
 * replicated state. A local build, on the other hand, leaves the image only
 * on the node that built it — hence the placement constraint that pins each
 * service to ITS node, independently of the one that receives the Swarm
 * command.
 *
 * A single manager in Phase 2, deliberately: beyond that, the size of the
 * Raft quorum becomes an operational decision in its own right (staying
 * odd), outside the scope kept here.
 */
export const serverRole = pgEnum("server_role", ["manager", "worker"]);

export const servers = pgTable(
  "servers",
  {
    createdAt,

    // The daemon's minimum Docker API version, recorded on connection.
    // Traefik < 3.6 speaks API 1.24 and Docker 29 refuses it: that pairing
    // is what broke Phase 0, and Noddle checks both sides.
    dockerApiMinVersion: text("docker_api_min_version"),
    dockerVersion: text("docker_version"),
    host: text("host").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),

    // The machine hosting Noddle is registered as target server #1.
    // DISPLAY ONLY — never wire code onto it. The local target goes through
    // the SSH executor like any other, precisely so that this path is
    // exercised by every single-machine user.
    //
    // `role`, below, is the field that carries the orchestration fact: two
    // independent columns, even though in Phase 2 it's ALWAYS the isSelf
    // machine that is also the manager — because it alone ran
    // `docker swarm init`, never because the code would have inferred it
    // from isSelf.
    isSelf: boolean("is_self").notNull().default(false),

    // Why an installation failed to join, visible without digging through
    // the worker's logs. `status` alone says WHAT (pending/unreachable),
    // not WHY.
    lastError: text("last_error"),
    name: text("name").notNull(),

    // The daily prune touches this node, EXCEPT when this boolean says no.
    // `true` by default: that's the pre-existing behavior for this
    // setting, and an existing installation shouldn't end up with a disk
    // that grows without anyone having asked for anything new.
    //
    // Disabling does NOT remove the node from reconciliation: its images
    // stay listed, otherwise a node that's just "spared" would become a
    // node we know nothing about anymore, and `reconciledFully` would lie
    // by omission about that specific node.
    pruneEnabled: boolean("prune_enabled").notNull().default(true),

    role: serverRole("role").notNull().default("worker"),

    // The key comes from the LIBRARY, it's no longer copied into the row.
    // `restrict` and not `cascade`: deleting a key that's still in use must
    // be refused, not silently take down the machines it opens.
    sshKeyId: uuid("ssh_key_id")
      .notNull()
      .references(() => sshKeys.id, { onDelete: "restrict" }),
    sshPort: integer("ssh_port").notNull().default(22),
    sshUser: text("ssh_user").notNull(),

    status: serverStatus("status").notNull().default("pending"),

    // This node's identifier WITHIN the Swarm cluster — the one `docker
    // info` reports locally, to be distinguished from `id`, which is a
    // database identifier. It's the one a `node.id==…` constraint carries,
    // and the one a task carries when you want to know on WHICH machine it
    // is actually running.
    //
    // Recorded at provisioning rather than at every deployment: the fact
    // only changes if the node leaves and rejoins the cluster, which
    // precisely goes back through provisioning.
    swarmNodeId: text("swarm_node_id"),

    // Total memory recorded on the machine. The build ceiling is derived
    // from it, accounting for what the control plane already consumes.
    totalMemoryMb: integer("total_memory_mb"),
    updatedAt,
  },
  (t) => [
    uniqueIndex("servers_host_port_user_idx").on(t.host, t.sshPort, t.sshUser),
  ]
);
