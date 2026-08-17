/**
 * biome-ignore-all lint/performance/noBarrelFile: package public surface
 */
export {
  listServiceVolumeMounts,
  type ServiceVolumeMount,
} from "./service-volumes.ts";
export {
  type DeployOutcome,
  type DeploySpec,
  deployService,
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  type RegistryAuth,
  readRunningNodeId,
  readUpdateState,
  removeService,
  restartService,
  type SwarmUpdateState,
  scaleService,
  scaleServiceAndWait,
  waitForRunningTask,
} from "./swarm.ts";
export {
  CRASH_LOOP_THRESHOLD,
  inspectServiceHealth,
  WATCH_WINDOW_MS,
  type WatchVerdict,
  watchUntilFor,
} from "./watch.ts";
