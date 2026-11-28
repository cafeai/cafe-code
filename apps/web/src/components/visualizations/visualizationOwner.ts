import type { EnvironmentId } from "@cafecode/contracts";
import { readEnvironmentApi } from "../../environmentApi";
import { getPrimaryKnownEnvironment, isLoopbackHostname } from "../../environments/primary";
import {
  getSavedEnvironmentRecord,
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { getWsConnectionStatus, wsConnectionStatusAtom } from "../../rpc/wsConnectionState";
import { useCallback, useSyncExternalStore } from "react";

const transportIdentities = new WeakMap<object, number>();
let nextTransportIdentity = 0;

function isSecureVisualizationHttpUrl(httpBaseUrl: string): boolean {
  try {
    const parsed = new URL(httpBaseUrl);
    return parsed.protocol === "https:" || isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function hasSecureVisualizationTransport(
  environmentId: EnvironmentId,
  connection: ReturnType<typeof readEnvironmentConnection>,
): boolean {
  if (connection?.kind === "saved") {
    const record = getSavedEnvironmentRecord(environmentId);
    if (!record) return true;
    return record.transport === "relay" || isSecureVisualizationHttpUrl(record.httpBaseUrl);
  }
  if (connection?.kind === "primary") {
    const primary = getPrimaryKnownEnvironment();
    if (!primary || primary.environmentId !== environmentId) return true;
    return isSecureVisualizationHttpUrl(primary.target.httpBaseUrl);
  }
  return true;
}

/** Matches the server's `privateVisualizationRead` owner + secure-transport gate
 * so non-owner or cleartext remote HTTP connections don't issue doomed list
 * requests that leave a permanent refresh-failure banner on every chat. */
export function canReadVisualizationHistory(environmentId: EnvironmentId): boolean {
  const connection = readEnvironmentConnection(environmentId);
  if (!hasSecureVisualizationTransport(environmentId, connection)) return false;
  if (connection?.kind === "saved") {
    const state = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
    return (
      state?.connectionState === "connected" &&
      state.authState === "authenticated" &&
      state.role === "owner"
    );
  }
  if (connection?.kind === "primary") {
    return getWsConnectionStatus().phase === "connected";
  }
  return true;
}

/** Public list recovery may re-read on a fresh authenticated generation. Private
 * readers and native viewers do not use this hook: reconnect still revokes them
 * until the user explicitly opens/runs the exact artifact again. */
export function useVisualizationTransportRevision(environmentId: EnvironmentId) {
  const subscribe = useCallback((changed: () => void) => {
    const connection = subscribeEnvironmentConnections(changed);
    const saved = useSavedEnvironmentRuntimeStore.subscribe(changed);
    const savedRegistry = useSavedEnvironmentRegistryStore.subscribe(changed);
    const primary = appAtomRegistry.subscribe(wsConnectionStatusAtom, changed);
    return () => {
      connection();
      saved();
      savedRegistry();
      primary();
    };
  }, []);
  const read = useCallback(() => {
    const connection = readEnvironmentConnection(environmentId);
    let identity = 0;
    if (connection) {
      const known = transportIdentities.get(connection);
      if (known !== undefined) identity = known;
      else {
        identity = ++nextTransportIdentity;
        transportIdentities.set(connection, identity);
      }
    }
    if (connection?.kind === "primary") {
      const status = getWsConnectionStatus();
      return JSON.stringify([identity, status.phase, status.connectedAt]);
    }
    const state = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
    const record = getSavedEnvironmentRecord(environmentId);
    return JSON.stringify([
      identity,
      state?.connectionState,
      state?.authState,
      state?.role,
      state?.connectedAt,
      record?.transport,
      record?.httpBaseUrl,
    ]);
  }, [environmentId]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * A disclosure belongs to one admitted transport generation, not just a chat
 * spelling. Reconnecting, replacing an adapter or losing owner role revokes
 * private bytes and native response authority; recovery requires a new gesture.
 * This reads existing volatile transport metadata, never provider credentials.
 */
export function observeVisualizationOwner(environmentId: EnvironmentId, revoke: () => void) {
  const api = readEnvironmentApi(environmentId);
  const connection = readEnvironmentConnection(environmentId);
  const openedAt = connection?.kind === "primary" ? getWsConnectionStatus().connectedAt : null;
  const savedOpenedAt =
    connection?.kind === "saved"
      ? useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.connectedAt
      : null;
  let disposed = false;
  let revoked = false;
  let notified = false;
  const matchesCurrentOwner = () => {
    if (readEnvironmentApi(environmentId) !== api) return false;
    if (readEnvironmentConnection(environmentId) !== connection) return false;
    if (!hasSecureVisualizationTransport(environmentId, connection)) return false;
    if (connection?.kind === "primary") {
      const status = getWsConnectionStatus();
      return status.phase === "connected" && status.connectedAt === openedAt;
    }
    if (connection?.kind === "saved") {
      const state = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
      return (
        state?.connectionState === "connected" &&
        state.authState === "authenticated" &&
        state.role === "owner" &&
        state.connectedAt === savedOpenedAt
      );
    }
    // Injected/older admitted adapters still pass the backend owner check.
    // Missing registry evidence is never labelled a local/native capability.
    return api !== undefined && api !== null;
  };
  const current = () => {
    if (disposed || revoked) return false;
    if (matchesCurrentOwner()) return true;
    // Authority loss is monotonic for this exact disclosure/Run gesture. A
    // restored role, authenticated status or same-clock reconnect cannot revive
    // already-pending private bytes or native responses. Reads may latch loss,
    // but never invoke an external callback from a render/ownership predicate.
    revoked = true;
    return false;
  };
  const changed = () => {
    if (disposed || current() || notified) return;
    // Set both latches BEFORE external cleanup. Re-entrant checks observe lost
    // ownership immediately, and repeated notifications cannot repeat cleanup.
    revoked = true;
    notified = true;
    revoke();
  };
  const offConnection = subscribeEnvironmentConnections(changed);
  const offSaved = useSavedEnvironmentRuntimeStore.subscribe(changed);
  const offSavedRegistry = useSavedEnvironmentRegistryStore.subscribe(changed);
  const offPrimary = appAtomRegistry.subscribe(wsConnectionStatusAtom, changed);
  return {
    api,
    current,
    dispose() {
      disposed = true;
      offConnection();
      offSaved();
      offSavedRegistry();
      offPrimary();
    },
  };
}
