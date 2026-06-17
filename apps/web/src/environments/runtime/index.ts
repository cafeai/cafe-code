export { getEnvironmentHttpBaseUrl, resolveEnvironmentHttpUrl } from "./catalog";

export {
  ensureEnvironmentConnectionBootstrapped,
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
  requireEnvironmentConnection,
  resetEnvironmentServiceForTests,
  startEnvironmentConnectionService,
  subscribeEnvironmentConnections,
} from "./service";
