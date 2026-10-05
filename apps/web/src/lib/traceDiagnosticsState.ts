import { useAtomValue } from "@effect/atom-react";
import type { ServerTraceDiagnosticsResult } from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { EnvironmentId } from "@cafecode/contracts";
import { ensureWorkspaceApi } from "../environments/workspaceApi";
import { readWorkspaceEnvironmentId, useWorkspaceEnvironmentId } from "../environments/workspace";
import { appAtomRegistry } from "../rpc/atomRegistry";

const TRACE_DIAGNOSTICS_STALE_TIME_MS = 5_000;
const TRACE_DIAGNOSTICS_IDLE_TTL_MS = 5 * 60_000;

const traceDiagnosticsAtom = Atom.family((environmentKey: string) =>
  Atom.make(
    Effect.promise(() =>
      ensureWorkspaceApi(
        environmentKey ? EnvironmentId.make(environmentKey) : null,
      ).server.getTraceDiagnostics(),
    ),
  ).pipe(
    Atom.swr({
      staleTime: TRACE_DIAGNOSTICS_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(TRACE_DIAGNOSTICS_IDLE_TTL_MS),
    Atom.withLabel(`trace-diagnostics:${environmentKey}`),
  ),
);

export interface TraceDiagnosticsState {
  readonly data: ServerTraceDiagnosticsResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function formatTraceDiagnosticsError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load trace diagnostics.";
}

function readTraceDiagnosticsError(
  result: AsyncResult.AsyncResult<ServerTraceDiagnosticsResult, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const squashed = Cause.squash(result.cause);
  return formatTraceDiagnosticsError(squashed);
}

export function refreshTraceDiagnostics(environmentId = readWorkspaceEnvironmentId()): void {
  appAtomRegistry.refresh(traceDiagnosticsAtom(environmentId ?? ""));
}

export function useTraceDiagnostics(): TraceDiagnosticsState {
  const environmentId = useWorkspaceEnvironmentId();
  const result = useAtomValue(traceDiagnosticsAtom(environmentId ?? ""));
  const data = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => {
    refreshTraceDiagnostics(environmentId);
  }, [environmentId]);

  return {
    data,
    error: readTraceDiagnosticsError(result),
    isPending: result.waiting,
    refresh,
  };
}
