export const MONITOR_SECONDS = 45;

export const SECOND_NS = 1_000_000_000;

export const DeployPolicy = {
  healthcheck: {
    intervalSeconds: 3,
    retries: 3,
    startPeriodSeconds: 5,
    timeoutSeconds: 2,
  },
  monitorSeconds: MONITOR_SECONDS,
  restart: {
    condition: "on-failure" as const,
    maxAttempts: 3,
    windowSeconds: 120,
  },
  rollback: {
    failureAction: "pause" as const,
    maxFailureRatio: 0,
    order: "start-first" as const,
    parallelism: 1,
  },
  update: {
    failureAction: "rollback" as const,
    maxFailureRatio: 0,
    order: "start-first" as const,
    parallelism: 1,
  },
} as const;

export function httpHealthcheckTest(port: number): string[] {
  return [
    "CMD-SHELL",
    `curl -fsS -o /dev/null http://127.0.0.1:${port}/ || exit 1`,
  ];
}

export function renderDockerodeUpdateConfig() {
  const { update, monitorSeconds } = DeployPolicy;
  return {
    FailureAction: update.failureAction,
    MaxFailureRatio: update.maxFailureRatio,
    Monitor: monitorSeconds * SECOND_NS,
    Order: update.order,
    Parallelism: update.parallelism,
  };
}

export function renderDockerodeRollbackConfig() {
  const { rollback, monitorSeconds } = DeployPolicy;
  return {
    FailureAction: rollback.failureAction,
    MaxFailureRatio: rollback.maxFailureRatio,
    Monitor: monitorSeconds * SECOND_NS,
    Order: rollback.order,
    Parallelism: rollback.parallelism,
  };
}

export function renderDockerodeRestartPolicy() {
  const { restart } = DeployPolicy;
  return {
    Condition: restart.condition,
    MaxAttempts: restart.maxAttempts,
    Window: restart.windowSeconds * SECOND_NS,
  };
}

export function renderDockerodeHttpHealthcheck(port: number) {
  const { healthcheck } = DeployPolicy;
  return {
    Interval: healthcheck.intervalSeconds * SECOND_NS,
    Retries: healthcheck.retries,
    StartPeriod: healthcheck.startPeriodSeconds * SECOND_NS,
    Test: httpHealthcheckTest(port),
    Timeout: healthcheck.timeoutSeconds * SECOND_NS,
  };
}

export function renderComposeUpdateConfig() {
  const { update, monitorSeconds } = DeployPolicy;
  return {
    failure_action: update.failureAction,
    max_failure_ratio: update.maxFailureRatio,
    monitor: `${monitorSeconds}s`,
    order: update.order,
    parallelism: update.parallelism,
  };
}

export function renderComposeRollbackConfig() {
  const { rollback, monitorSeconds } = DeployPolicy;
  return {
    failure_action: rollback.failureAction,
    max_failure_ratio: rollback.maxFailureRatio,
    monitor: `${monitorSeconds}s`,
    order: rollback.order,
    parallelism: rollback.parallelism,
  };
}

export function renderComposeRestartPolicy() {
  const { restart } = DeployPolicy;
  return {
    condition: restart.condition,
    max_attempts: restart.maxAttempts,
    window: `${restart.windowSeconds}s`,
  };
}

export function renderComposeHttpHealthcheck(port: number) {
  const { healthcheck } = DeployPolicy;
  return {
    interval: `${healthcheck.intervalSeconds}s`,
    retries: healthcheck.retries,
    start_period: `${healthcheck.startPeriodSeconds}s`,
    test: httpHealthcheckTest(port),
    timeout: `${healthcheck.timeoutSeconds}s`,
  };
}
