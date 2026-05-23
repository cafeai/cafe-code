import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type OrchestrationShellSnapshot } from "@cafecode/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { readEnvironmentApi } from "../environmentApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const DELETED_THREADS_STALE_TIME_MS = 5_000;
const DELETED_THREADS_IDLE_TTL_MS = 5 * 60_000;
const DELETED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";

export type DeletedSnapshotEntry = {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
};

const knownDeletedThreadEnvironmentKeys = new Set<string>();

function makeDeletedThreadsEnvironmentKey(environmentIds: ReadonlyArray<EnvironmentId>): string {
  return environmentIds.toSorted().join(DELETED_THREADS_ENVIRONMENT_KEY_SEPARATOR);
}

function parseDeletedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return key
    .split(DELETED_THREADS_ENVIRONMENT_KEY_SEPARATOR)
    .map((environmentId) => EnvironmentId.make(environmentId));
}

const deletedThreadSnapshotsAtom = Atom.family((environmentKey: string) => {
  knownDeletedThreadEnvironmentKeys.add(environmentKey);
  return Atom.make(
    Effect.promise(async (): Promise<ReadonlyArray<DeletedSnapshotEntry>> => {
      const environmentIds = parseDeletedThreadsEnvironmentKey(environmentKey);
      const snapshots = await Promise.all(
        environmentIds.map(async (environmentId) => {
          const api = readEnvironmentApi(environmentId);
          if (!api) {
            return null;
          }
          return {
            environmentId,
            snapshot: await api.orchestration.getDeletedShellSnapshot(),
          };
        }),
      );
      return snapshots.filter((snapshot) => snapshot !== null);
    }),
  ).pipe(
    Atom.swr({
      staleTime: DELETED_THREADS_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(DELETED_THREADS_IDLE_TTL_MS),
    Atom.withLabel(`deleted-thread-snapshots:${environmentKey}`),
  );
});

function readDeletedThreadsError(
  result: AsyncResult.AsyncResult<ReadonlyArray<DeletedSnapshotEntry>, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Failed to load recently deleted threads.";
}

export function refreshDeletedThreadsForEnvironment(environmentId: EnvironmentId): void {
  for (const key of knownDeletedThreadEnvironmentKeys) {
    if (parseDeletedThreadsEnvironmentKey(key).includes(environmentId)) {
      appAtomRegistry.refresh(deletedThreadSnapshotsAtom(key));
    }
  }
}

export function useDeletedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<DeletedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeDeletedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const atom = deletedThreadSnapshotsAtom(environmentKey);
  const result = useAtomValue(atom);
  const snapshots = Option.getOrElse(AsyncResult.value(result), () => []);
  const refresh = useCallback(() => {
    appAtomRegistry.refresh(atom);
  }, [atom]);

  return {
    snapshots,
    error: readDeletedThreadsError(result),
    isLoading: result.waiting,
    refresh,
  };
}
