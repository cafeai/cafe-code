import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DesktopSourceUpdateState } from "@cafecode/contracts";

export const desktopSourceUpdateQueryKeys = {
  all: ["desktop", "sourceUpdate"] as const,
  state: () => ["desktop", "sourceUpdate", "state"] as const,
};

export const setDesktopSourceUpdateStateQueryData = (
  queryClient: QueryClient,
  state: DesktopSourceUpdateState | null,
) => queryClient.setQueryData(desktopSourceUpdateQueryKeys.state(), state);

export function desktopSourceUpdateStateQueryOptions() {
  return queryOptions({
    queryKey: desktopSourceUpdateQueryKeys.state(),
    queryFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getSourceUpdateState !== "function") return null;
      return bridge.getSourceUpdateState();
    },
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

export function useDesktopSourceUpdateState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopSourceUpdateStateQueryOptions());

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onSourceUpdateState !== "function") return;

    return bridge.onSourceUpdateState((nextState) => {
      setDesktopSourceUpdateStateQueryData(queryClient, nextState);
    });
  }, [queryClient]);

  return query;
}
