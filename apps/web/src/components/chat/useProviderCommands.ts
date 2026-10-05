import { useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProviderCommandCatalog,
  ProviderCommandsInput,
} from "@cafecode/contracts";
import { requireEnvironmentConnection } from "../../environments/runtime";

const UNAVAILABLE: ProviderCommandCatalog = { status: "unavailable", commands: [] };
const LOADING: ProviderCommandCatalog = { status: "loading", commands: [] };

/** The picker owns a volatile read subscription. Scope changes invalidate in
 * render, before effect cleanup, so old commands cannot flash under a different
 * account/project. Transport reconnect obtains a fresh server snapshot; no
 * command catalog is retained in local storage or treated as live while offline. */
export function useProviderCommands(
  environmentId: EnvironmentId,
  input: ProviderCommandsInput | null,
  open: boolean,
  scopeRevision: string,
  connected = true,
): ProviderCommandCatalog {
  const key = JSON.stringify([environmentId, input, scopeRevision]);
  const request = useMemo(() => ({ key, open, connected }), [key, open, connected]);
  const [state, setState] = useState<{
    request: typeof request;
    catalog: ProviderCommandCatalog;
  } | null>(null);
  useEffect(() => {
    if (!open || !input || !connected) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (catalog: ProviderCommandCatalog) => {
      if (!current) return;
      clearTimeout(timer);
      setState({ request, catalog });
    };
    const awaitingSnapshot = () => {
      publish(LOADING);
      // Covers a failed/older server endpoint or a transport that cannot yet
      // deliver its first snapshot. A late valid snapshot may still recover.
      timer = setTimeout(() => publish(UNAVAILABLE), 6_000);
    };
    awaitingSnapshot();
    let close: (() => void) | undefined;
    try {
      close = requireEnvironmentConnection(environmentId).client.server.subscribeProviderCommands(
        input,
        publish,
        { onResubscribe: awaitingSnapshot, retryNonTransportErrors: true },
      );
    } catch {
      publish(UNAVAILABLE);
    }
    return () => {
      current = false;
      clearTimeout(timer);
      close?.();
    };
  }, [environmentId, input, open, request, connected]);
  if (!input || !connected) return UNAVAILABLE;
  return state?.request === request ? state.catalog : LOADING;
}
