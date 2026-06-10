export {
  getPrimaryKnownEnvironment,
  readPrimaryEnvironmentDescriptor,
  resetPrimaryEnvironmentDescriptorForTests,
  resolveInitialPrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
  writePrimaryEnvironmentDescriptor,
  __resetPrimaryEnvironmentBootstrapForTests,
  __resetPrimaryEnvironmentDescriptorBootstrapForTests,
} from "./context";

export {
  resolveInitialPrimaryEnvironmentDescriptor as ensurePrimaryEnvironmentReady,
  writePrimaryEnvironmentDescriptor as updatePrimaryEnvironmentDescriptor,
} from "./context";

export {
  clearServerAdminPassword,
  createServerPairingCredential,
  fetchServerAdminPasswordStatus,
  fetchSessionState,
  listServerClientSessions,
  listServerPairingLinks,
  peekPairingTokenFromUrl,
  resolveInitialServerAuthGateState,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  setServerAdminPassword,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
  submitServerPasswordCredential,
  takePairingTokenFromUrl,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
  __resetServerAuthBootstrapForTests,
} from "./auth";

export { resolvePrimaryEnvironmentHttpUrl, isLoopbackHostname } from "./target";
