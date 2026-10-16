import type {
  EnvironmentId,
  ProviderCommandCatalog,
  ProviderCommandsInput,
} from "@cafecode/contracts";
import { useEffect, useMemo, useState } from "react";
import { requireEnvironmentConnection } from "../../environments/runtime";
import { subscribeMetadata } from "./metadataSubscription";

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
    return subscribeMetadata({
      loading: LOADING,
      unavailable: UNAVAILABLE,
      publish: (catalog) => setState({ request, catalog }),
      subscribe: (publish, awaitingSnapshot) =>
        requireEnvironmentConnection(environmentId).client.server.subscribeProviderCommands(
          input,
          publish,
          { onResubscribe: awaitingSnapshot, retryNonTransportErrors: true },
        ),
    });
  }, [environmentId, input, open, request, connected]);
  if (!input || !connected) return UNAVAILABLE;
  return state?.request === request ? state.catalog : LOADING;
}

// Finite source-owned labels/helpers only; no received or user data.
