import { z } from "zod";

export const DEPLOY_QUEUE_NAME = "noddle-deploy";

export const DEPLOY_QUEUE_CONCURRENCY = 1;

const lifecycleActionSchema = z.enum(["restart", "start", "stop"]);

export const deployJobSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    backupId: z.uuid(),
    kind: z.literal("backup"),
  }),
  z.strictObject({
    kind: z.literal("volume-backup"),
    volumeBackupId: z.uuid(),
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
  z.strictObject({
    kind: z.literal("prune-docker"),
  }),
  z.strictObject({
    kind: z.literal("restart-swarm-service"),
    serviceName: z.string().min(1),
  }),
  z.strictObject({
    databaseDeploymentId: z.uuid().optional(),
    databaseId: z.uuid(),
    kind: z.literal("provision-database"),
  }),
  z.strictObject({
    kind: z.literal("configure-dashboard-domain"),
  }),
  z.strictObject({
    kind: z.literal("reload-control-plane"),
  }),
  z.strictObject({
    kind: z.literal("provision-server"),
    serverId: z.uuid(),
  }),
  z.strictObject({
    databaseDeploymentId: z.uuid().optional(),
    databaseId: z.uuid(),
    kind: z.literal("rebuild-database"),
  }),
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
    destinationId: z.uuid().optional(),
    kind: z.literal("volume-restore"),
    objectKey: z.string().min(1).optional(),
    serviceId: z.uuid(),
    volumeBackupId: z.uuid().optional(),
    volumeName: z.string().min(1).optional(),
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
