export {
  deleteManifest,
  ensureRegistryTrust,
  garbageCollect,
  KEEP_PER_SERVICE,
  parseRegistryRef,
} from "./internal/registry.ts";
export { listServiceVolumeMounts } from "./internal/service-volumes.ts";
export {
  removeService,
  restartService,
  scaleService,
  scaleServiceAndWait,
  waitForRunningTask,
} from "./internal/swarm.ts";
