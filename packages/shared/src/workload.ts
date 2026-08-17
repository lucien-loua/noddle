/**
 * ADR-0012 workload policy — one module, three Swarm spec builders.
 *
 * App services (`swarm-ops`), Compose stacks (`compose-engine`) and
 * database services (`database.ts`) all inherit the same deploy / rollback /
 * restart numbers. Database rows may override individual fields via
 * `swarm_settings`; absent keys keep the shared defaults.
 */
import {
  renderComposeRestartPolicy,
  renderComposeRollbackConfig,
  renderComposeUpdateConfig,
  renderDockerodeRestartPolicy,
  renderDockerodeRollbackConfig,
  renderDockerodeUpdateConfig,
} from "#deploy-policy";

export interface DockerodeUpdateConfig {
  Delay?: number;
  FailureAction: "continue" | "pause" | "rollback";
  MaxFailureRatio: number;
  Monitor: number;
  Order: "start-first" | "stop-first";
  Parallelism: number;
}

export interface DockerodeRollbackConfig {
  Delay?: number;
  FailureAction: "continue" | "pause";
  MaxFailureRatio: number;
  Monitor: number;
  Order: "start-first" | "stop-first";
  Parallelism: number;
}

export interface DockerodeRestartPolicy {
  Condition: "any" | "none" | "on-failure";
  Delay?: number;
  MaxAttempts: number;
  Window: number;
}

/** Engine API / dockerode UpdateConfig fields (nanosecond durations). */
export type DockerodeUpdateConfigOverride = Partial<{
  Delay: number | null;
  FailureAction: "continue" | "pause" | "rollback";
  MaxFailureRatio: number | null;
  Monitor: number | null;
  Order: "start-first" | "stop-first";
  Parallelism: number | null;
}>;

export type DockerodeRollbackConfigOverride = Partial<{
  Delay: number | null;
  FailureAction: "continue" | "pause";
  MaxFailureRatio: number | null;
  Monitor: number | null;
  Order: "start-first" | "stop-first";
  Parallelism: number | null;
}>;

export type DockerodeRestartPolicyOverride = Partial<{
  Condition: "any" | "none" | "on-failure";
  Delay: number | null;
  MaxAttempts: number | null;
  Window: number | null;
}>;

function mergeDefined<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown> | null | undefined,
): T {
  if (!override) {
    return base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

export function resolveDockerodeUpdateConfig(
  override?: DockerodeUpdateConfigOverride | null,
): DockerodeUpdateConfig {
  return mergeDefined(renderDockerodeUpdateConfig(), override);
}

export function resolveDockerodeRollbackConfig(
  override?: DockerodeRollbackConfigOverride | null,
): DockerodeRollbackConfig {
  return mergeDefined(renderDockerodeRollbackConfig(), override);
}

export function resolveDockerodeRestartPolicy(
  override?: DockerodeRestartPolicyOverride | null,
): DockerodeRestartPolicy {
  return mergeDefined(renderDockerodeRestartPolicy(), override);
}

/** Shared deploy / rollback / restart block for dockerode service specs. */
export function dockerodeWorkloadPolicy(opts?: {
  restartPolicy?: DockerodeRestartPolicyOverride | null;
  rollbackConfig?: DockerodeRollbackConfigOverride | null;
  updateConfig?: DockerodeUpdateConfigOverride | null;
}) {
  return {
    RestartPolicy: resolveDockerodeRestartPolicy(opts?.restartPolicy),
    RollbackConfig: resolveDockerodeRollbackConfig(opts?.rollbackConfig),
    UpdateConfig: resolveDockerodeUpdateConfig(opts?.updateConfig),
  };
}

/** Compose `deploy.*` keys injected before `docker stack deploy`. */
export function composeWorkloadDeploy() {
  return {
    restart_policy: renderComposeRestartPolicy(),
    rollback_config: renderComposeRollbackConfig(),
    update_config: renderComposeUpdateConfig(),
  };
}
