import {
  queryOptions,
  replaceEqualDeep,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type { DesktopBridge, DesktopSourceUpdateState } from "@cafecode/contracts";

// Source branch diagnostics obey the same native-owner and actual cache-commit
// boundary as packaged updates. Keep receipts off received/public state objects.
const initialReadReceipts = new WeakMap<
  object,
  {
    readonly client: QueryClient;
    readonly query: object | undefined;
    readonly dataUpdateCount: number;
    readonly bridge: DesktopBridge;
    readonly signal: AbortSignal;
  }
>();

export const desktopSourceUpdateQueryKeys = {
  all: ["desktop", "sourceUpdate"] as const,
  state: () => ["desktop", "sourceUpdate", "state"] as const,
};

export const setDesktopSourceUpdateStateQueryData = (
  queryClient: QueryClient,
  state: DesktopSourceUpdateState,
) => queryClient.setQueryData(desktopSourceUpdateQueryKeys.state(), state);

export function desktopSourceUpdateStateQueryOptions(queryClient: QueryClient) {
  return queryOptions({
    queryKey: desktopSourceUpdateQueryKeys.state(),
    queryFn: async ({ client, signal }) => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getSourceUpdateState !== "function") return null;
      const query = client
        .getQueryCache()
        .find({ queryKey: desktopSourceUpdateQueryKeys.state(), exact: true });
      const receipt = {
        client,
        query,
        dataUpdateCount: query?.state.dataUpdateCount ?? 0,
        bridge,
        signal,
      };
      const state = await bridge.getSourceUpdateState();
      signal.throwIfAborted();
      const snapshot = { ...state };
      initialReadReceipts.set(snapshot, receipt);
      return snapshot;
    },
    structuralSharing: (previous, next) => {
      // Null is an automatic no-bridge observation, not a native revocation.
      if (next === null && window.desktopBridge) return previous ?? null;
      const receipt =
        typeof next === "object" && next !== null ? initialReadReceipts.get(next) : undefined;
      if (
        receipt &&
        (receipt.client !== queryClient ||
          receipt.signal.aborted ||
          receipt.bridge !== window.desktopBridge ||
          receipt.query === undefined ||
          queryClient
            .getQueryCache()
            .find({ queryKey: desktopSourceUpdateQueryKeys.state(), exact: true }) !==
            receipt.query ||
          queryClient.getQueryState(desktopSourceUpdateQueryKeys.state())?.dataUpdateCount !==
            receipt.dataUpdateCount)
      ) {
        return previous ?? null;
      }
      return replaceEqualDeep(previous, next);
    },
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

export function useDesktopSourceUpdateState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopSourceUpdateStateQueryOptions(queryClient));

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onSourceUpdateState !== "function") return;

    let retired = false;
    const unsubscribe = bridge.onSourceUpdateState((nextState) => {
      if (retired || window.desktopBridge !== bridge) return;
      setDesktopSourceUpdateStateQueryData(queryClient, nextState);
    });
    return () => {
      retired = true;
      unsubscribe();
    };
  }, [queryClient]);

  return query;
}
