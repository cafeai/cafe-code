import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { findCafeSecretReferenceRanges } from "@cafecode/shared/cafeSecrets";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { getWsConnectionStatus, wsConnectionStatusAtom } from "../rpc/wsConnectionState";
import { readThreadSecretsApi } from "./cafeSecretsClient";
import { subscribeCafeSecretsChanges } from "./changes";

const EMPTY_VALUES: ReadonlyMap<string, string> = new Map();
const SERVER_ADMISSION = { api: undefined, connection: null, transport: null };
const readServerAdmission = () => SERVER_ADMISSION;

function readTransport(environmentId: EnvironmentId): string | null {
  const connection = readEnvironmentConnection(environmentId);
  if (connection?.kind === "primary") {
    const status = getWsConnectionStatus();
    return status.phase === "connected" ? `primary:${status.connectedAt}` : null;
  }
  if (connection?.kind === "saved") {
    const status = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
    return status?.connectionState === "connected" &&
      status.authState === "authenticated" &&
      status.role === "owner"
      ? "saved-owner"
      : null;
  }
  // Adapters without a registry entry still use the server's owner-only API.
  return "adapter";
}

function historyAdmission(environmentId: EnvironmentId, threadId: ThreadId | null) {
  const read = () => ({
    api: readThreadSecretsApi(environmentId),
    connection: readEnvironmentConnection(environmentId),
    transport: readTransport(environmentId),
  });
  let snapshot = read();
  const getSnapshot = () => {
    const next = read();
    if (
      next.api !== snapshot.api ||
      next.connection !== snapshot.connection ||
      next.transport !== snapshot.transport
    )
      snapshot = next;
    return snapshot;
  };
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      const observe = () => {
        getSnapshot();
        listener();
      };
      const unsubscribeRegistry = subscribeEnvironmentConnections(observe);
      const unsubscribeSaved = useSavedEnvironmentRuntimeStore.subscribe(observe);
      const unsubscribePrimary = appAtomRegistry.subscribe(wsConnectionStatusAtom, observe);
      const unsubscribeSecrets = subscribeCafeSecretsChanges((thread) => {
        if (thread.environmentId !== environmentId || thread.threadId !== threadId) return;
        snapshot = { ...getSnapshot() };
        listener();
      });
      return () => {
        unsubscribeRegistry();
        unsubscribeSaved();
        unsubscribePrimary();
        unsubscribeSecrets();
      };
    },
  };
}

/**
 * Private, view-owned presentation of user messages. Only references in this
 * chat's user history are read, with at most 64 values and four pending reads.
 * No value enters the message model, a query cache, browser storage or logs.
 */
export function useCafeSecretHistory(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  texts: readonly string[];
}): ReadonlyMap<string, string> {
  const { environmentId, threadId } = input;
  const admission = useMemo(
    () => historyAdmission(environmentId, threadId),
    [environmentId, threadId],
  );
  const scope = useSyncExternalStore(
    admission.subscribe,
    admission.getSnapshot,
    readServerAdmission,
  );
  const { api, transport } = scope;
  // Keep the native request cap through scope replacement: retired RPCs still
  // occupy slots until their original promises settle. Only the latest queue
  // may fill released slots; retired queued reads are never admitted.
  const pool = useRef<{ pending: number; pump: (() => void) | null }>({ pending: 0, pump: null });
  const currentScope = useRef<typeof scope | null>(null);
  const [loaded, setLoaded] = useState<{
    scope: typeof scope;
    values: ReadonlyMap<string, string>;
  } | null>(null);
  const loadedRef = useRef(loaded);
  useLayoutEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);
  useLayoutEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = null;
    };
  }, [scope]);
  const ids = new Set<string>();
  for (const text of input.texts) {
    for (const { id } of findCafeSecretReferenceRanges(text)) {
      ids.add(id);
    }
  }
  const signature = [...ids].toSorted().join(",");

  useEffect(() => {
    if (!api || !threadId || transport === null || signature.length === 0) {
      setLoaded(null);
      return;
    }
    let retired = false;
    if (loadedRef.current?.scope !== scope) setLoaded(null);
    const owns = () =>
      !retired && currentScope.current === scope && admission.getSnapshot() === scope;
    const values = new Map(
      loadedRef.current?.scope === scope ? loadedRef.current.values : EMPTY_VALUES,
    );
    const referenced = new Set(signature.split(","));
    let requested: string[] = [];
    let listed = false;
    let listing = false;
    let activeReads = 0;
    const owner = pool.current;
    const publish = () => {
      if (owns()) setLoaded({ scope, values: new Map(values) });
    };
    const readList = async () => {
      try {
        const result = await api.list({ threadId });
        if (!owns()) return;
        // The vault's bounded current catalog keeps removed/foreign historical
        // references from exhausting the value budget or starving newer ones.
        requested = result.secrets
          .slice(0, 64)
          .map((secret) => secret.id)
          .filter((id) => referenced.has(id));
      } catch {
        // Fixed safe references remain visible when the private read fails.
      }
      if (owns()) listed = true;
    };
    let cursor = 0;
    const readValue = async (id: string) => {
      try {
        const { value } = await api.reveal({ threadId, id });
        if (
          owns() &&
          typeof value === "string" &&
          value.length > 0 &&
          value.length <= 16_384 &&
          new TextEncoder().encode(value).length <= 16_384
        )
          values.set(id, value);
      } catch {
        // Received errors can contain private material; never display them.
      }
    };
    const start = (operation: () => Promise<void>) => {
      owner.pending++;
      activeReads++;
      void operation().finally(() => {
        owner.pending--;
        activeReads--;
        owner.pump?.();
      });
    };
    const pump = () => {
      if (!owns()) return;
      if (!listed) {
        if (!listing && owner.pending < 4) {
          listing = true;
          start(readList);
        }
        return;
      }
      for (const id of values.keys()) if (!requested.includes(id)) values.delete(id);
      while (owner.pending < 4 && cursor < requested.length) {
        const id = requested[cursor++]!;
        if (!values.has(id)) start(() => readValue(id));
      }
      if (cursor === requested.length && activeReads === 0) publish();
    };
    owner.pump = pump;
    pump();
    return () => {
      retired = true;
      if (owner.pump === pump) owner.pump = null;
      values.clear();
    };
  }, [admission, api, scope, signature, threadId, transport]);

  return loaded?.scope === scope && transport !== null ? loaded.values : EMPTY_VALUES;
}
