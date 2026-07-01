import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DesktopReleaseUpdateState } from "@cafecode/contracts";

export const desktopReleaseUpdateQueryKeys = {
  all: ["desktop", "releaseUpdate"] as const,
  state: () => ["desktop", "releaseUpdate", "state"] as const,
};

export const setDesktopReleaseUpdateStateQueryData = (
  queryClient: QueryClient,
  state: DesktopReleaseUpdateState | null,
) => queryClient.setQueryData(desktopReleaseUpdateQueryKeys.state(), state);

export function desktopReleaseUpdateStateQueryOptions() {
  return queryOptions({
    queryKey: desktopReleaseUpdateQueryKeys.state(),
    queryFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getReleaseUpdateState !== "function") return null;
      return bridge.getReleaseUpdateState();
    },
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

export function useDesktopReleaseUpdateState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopReleaseUpdateStateQueryOptions());

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onReleaseUpdateState !== "function") return;

    return bridge.onReleaseUpdateState((nextState) => {
      setDesktopReleaseUpdateStateQueryData(queryClient, nextState);
    });
  }, [queryClient]);

  return query;
}
