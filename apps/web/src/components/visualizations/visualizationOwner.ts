import type { EnvironmentId } from "@cafecode/contracts";
import { readEnvironmentApi } from "../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { getWsConnectionStatus, wsConnectionStatusAtom } from "../../rpc/wsConnectionState";
import { useCallback, useSyncExternalStore } from "react";

const transportIdentities = new WeakMap<object, number>();
let nextTransportIdentity = 0;
/** Public list recovery may re-read on a fresh authenticated generation. Private
 * readers and native viewers do not use this hook: reconnect still revokes them
 * until the user explicitly opens/runs the exact artifact again. */
export function useVisualizationTransportRevision(environmentId: EnvironmentId) {
  const subscribe = useCallback((changed: () => void) => {
    const connection = subscribeEnvironmentConnections(changed);
    const saved = useSavedEnvironmentRuntimeStore.subscribe(changed);
    const primary = appAtomRegistry.subscribe(wsConnectionStatusAtom, changed);
    return () => {
      connection();
      saved();
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
    return JSON.stringify([
      identity,
      state?.connectionState,
      state?.authState,
      state?.role,
      state?.connectedAt,
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
  const current = () => {
    if (disposed || readEnvironmentApi(environmentId) !== api) return false;
    if (readEnvironmentConnection(environmentId) !== connection) return false;
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
  const changed = () => {
    if (!current()) revoke();
  };
  const offConnection = subscribeEnvironmentConnections(changed);
  const offSaved = useSavedEnvironmentRuntimeStore.subscribe(changed);
  const offPrimary = appAtomRegistry.subscribe(wsConnectionStatusAtom, changed);
  return {
    api,
    current,
    dispose() {
      disposed = true;
      offConnection();
      offSaved();
      offPrimary();
    },
  };
}
