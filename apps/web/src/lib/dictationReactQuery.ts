import type { EnvironmentId } from "@cafecode/contracts";
import { queryOptions } from "@tanstack/react-query";

import { requireEnvironmentConnection } from "~/environments/runtime";

const DICTATION_STATUS_STALE_TIME_MS = 15_000;

export const dictationQueryKeys = {
  all: ["dictation"] as const,
  status: (environmentId: EnvironmentId | null) =>
    [...dictationQueryKeys.all, "status", environmentId] as const,
};

/**
 * Keep credential presence backend-authoritative and scoped to the selected
 * Cafe environment. The query returns only the boolean management status;
 * neither the permanent OpenAI key nor a short-lived Realtime secret enters
 * TanStack Query's cache.
 */
export function dictationStatusQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: dictationQueryKeys.status(environmentId),
    queryFn: () => {
      if (environmentId === null) {
        throw new Error("Dictation status requires an environment.");
      }
      return requireEnvironmentConnection(environmentId).client.dictation.getStatus();
    },
    enabled: environmentId !== null,
    staleTime: DICTATION_STATUS_STALE_TIME_MS,
    retry: false,
  });
}
