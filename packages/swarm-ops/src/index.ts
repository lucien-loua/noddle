export {
  listServiceVolumeMounts,
  type ServiceVolumeMount,
} from "./service-volumes.ts";
export {
  awaitSwarmVerdict,
  type DeployOutcome,
  type DeploySpec,
  deployService,
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  type RegistryAuth,
  readRunningNodeId,
  removeService,
  restartService,
  type SwarmUpdateState,
  scaleService,
  scaleServiceAndWait,
  waitForRunningTask,
} from "./swarm.ts";
export {
  inspectServiceHealth,
  WATCH_WINDOW_MS,
  type WatchVerdict,
  watchUntilFor,
} from "./watch.ts";
