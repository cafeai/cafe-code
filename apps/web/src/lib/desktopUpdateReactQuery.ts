import {
  queryOptions,
  replaceEqualDeep,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type { DesktopBridge, DesktopUpdateState } from "@cafecode/contracts";

// Provenance is private and weakly held; neither IPC data nor the public cache
// gains tags. Query options can change while a shared fetch is pending, so the
// actual result object, rather than one hook's render closure, owns its receipt.
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

export const desktopUpdateQueryKeys = {
  all: ["desktop", "update"] as const,
  state: () => ["desktop", "update", "state"] as const,
};

export const setDesktopUpdateStateQueryData = (
  queryClient: QueryClient,
  state: DesktopUpdateState,
) => queryClient.setQueryData(desktopUpdateQueryKeys.state(), state);

export function desktopUpdateStateQueryOptions(queryClient: QueryClient) {
  return queryOptions({
    queryKey: desktopUpdateQueryKeys.state(),
    queryFn: async ({ client, signal }) => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getUpdateState !== "function") return null;
      const query = client
        .getQueryCache()
        .find({ queryKey: desktopUpdateQueryKeys.state(), exact: true });
      const receipt = {
        client,
        query,
        dataUpdateCount: query?.state.dataUpdateCount ?? 0,
        bridge,
        signal,
      };
      const state = await bridge.getUpdateState();
      signal.throwIfAborted();
      // A native reply is not mutated or used as an identity token. A fresh
      // clone distinguishes this read from an identically valued later event.
      const snapshot = { ...state };
      initialReadReceipts.set(snapshot, receipt);
      return snapshot;
    },
    structuralSharing: (previous, next) => {
      // Null comes only from absence of the bridge, never a native state reply.
      // A bridge that appeared meanwhile may already have published valid data;
      // old absence cannot revoke it. Explicit update publishers are nonnull.
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
            .find({ queryKey: desktopUpdateQueryKeys.state(), exact: true }) !== receipt.query ||
          queryClient.getQueryState(desktopUpdateQueryKeys.state())?.dataUpdateCount !==
            receipt.dataUpdateCount)
      ) {
        // This executes inside TanStack's actual cache commit, not merely
        // before the async query function returns. Keep the newer publication.
        return previous ?? null;
      }
      return replaceEqualDeep(previous, next);
    },
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

export function useDesktopUpdateState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopUpdateStateQueryOptions(queryClient));

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onUpdateState !== "function") return;

    let retired = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (retired || window.desktopBridge !== bridge) return;
      setDesktopUpdateStateQueryData(queryClient, nextState);
    });
    return () => {
      retired = true;
      unsubscribe();
    };
  }, [queryClient]);

  return query;
}
