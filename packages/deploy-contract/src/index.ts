import { z } from "zod";

/**
 * BullMQ queue that carries every Swarm-touching job (deploy, lifecycle,
 * backup, prune, …). No `:` — BullMQ 6 uses it as a Redis key separator.
 */
export const DEPLOY_QUEUE_NAME = "noddle-deploy";

/**
 * Load-bearing: Swarm mutations, image push, and prune/GC must not race.
 * Two workers on this queue would let a deploy and a prune collide.
 */
export const DEPLOY_QUEUE_CONCURRENCY = 1;

const lifecycleActionSchema = z.enum(["restart", "start", "stop"]);

/**
 * Wire format for every job on {@link DEPLOY_QUEUE_NAME}.
 *
 * One schema for web producers and the worker consumer. The web never
 * enqueues `prune-*`; those are self-enqueued by the worker so they share
 * concurrency 1 with deploys.
 */
export const deployJobSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    backupId: z.uuid(),
    kind: z.literal("backup"),
  }),
  z.strictObject({
    databaseId: z.uuid(),
    kind: z.literal("change-database-password"),
    password: z.string().min(1),
  }),
  z.strictObject({
    databaseId: z.uuid(),
    kind: z.literal("delete-database"),
  }),
  z.strictObject({
    kind: z.literal("delete-server"),
    serverId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("delete-stack"),
    stackId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("delete-service"),
    serviceId: z.uuid(),
  }),
  z.strictObject({
    deploymentId: z.uuid(),
    kind: z.literal("deploy"),
  }),
  z.strictObject({
    kind: z.literal("deploy-stack"),
    stackDeploymentId: z.uuid(),
  }),
  z.strictObject({
    action: lifecycleActionSchema,
    kind: z.literal("lifecycle"),
    serviceId: z.uuid(),
  }),
  z.strictObject({
    action: lifecycleActionSchema,
    databaseId: z.uuid(),
    kind: z.literal("database-lifecycle"),
  }),
  // Between build and push the image has a tag and no container references
  // it yet — a concurrent prune would delete it. Same queue, concurrency 1.
  z.strictObject({
    kind: z.literal("prune-docker"),
  }),
  z.strictObject({
    kind: z.literal("restart-swarm-service"),
    serviceName: z.string().min(1),
  }),
  z.strictObject({
    databaseId: z.uuid(),
    kind: z.literal("provision-database"),
  }),
  z.strictObject({
    kind: z.literal("provision-server"),
    serverId: z.uuid(),
  }),
  z.strictObject({
    databaseId: z.uuid(),
    kind: z.literal("rebuild-database"),
  }),
  // `garbage-collect` deletes layers no manifest references; a layer being
  // pushed is exactly that case. Concurrency 1 forbids GC during push.
  z.strictObject({
    kind: z.literal("prune-registry"),
  }),
  z.strictObject({
    backupId: z.uuid().optional(),
    databaseId: z.uuid(),
    destinationId: z.uuid().optional(),
    kind: z.literal("restore"),
    objectKey: z.string().min(1).optional(),
  }),
  z.strictObject({
    imageTag: z.string().min(1),
    kind: z.literal("rollback"),
    serviceId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("rollback-stack"),
    sourceDeploymentId: z.uuid(),
    stackId: z.uuid(),
  }),
]);

export type DeployJobData = z.infer<typeof deployJobSchema>;
export type JobKind = DeployJobData["kind"];
export type PayloadOf<K extends JobKind> = Extract<DeployJobData, { kind: K }>;
