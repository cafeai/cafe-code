import { useAtomValue } from "@effect/atom-react";
import type { ServerRuntimeLayerDiagnosticsResult } from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { EnvironmentId } from "@cafecode/contracts";
import { ensureWorkspaceApi } from "../environments/workspaceApi";
import { readWorkspaceEnvironmentId, useWorkspaceEnvironmentId } from "../environments/workspace";
import { appAtomRegistry } from "../rpc/atomRegistry";

const RUNTIME_LAYER_DIAGNOSTICS_STALE_TIME_MS = 5_000;
const RUNTIME_LAYER_DIAGNOSTICS_IDLE_TTL_MS = 5 * 60_000;
const RUNTIME_LAYER_DIAGNOSTICS_INPUT = {
  windowMs: 15 * 60_000,
  bucketMs: 60_000,
} as const;

const runtimeLayerDiagnosticsAtom = Atom.family((environmentKey: string) =>
  Atom.make(
    Effect.promise(() =>
      ensureWorkspaceApi(
        environmentKey ? EnvironmentId.make(environmentKey) : null,
      ).server.getRuntimeLayerDiagnostics(RUNTIME_LAYER_DIAGNOSTICS_INPUT),
    ),
  ).pipe(
    Atom.swr({
      staleTime: RUNTIME_LAYER_DIAGNOSTICS_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(RUNTIME_LAYER_DIAGNOSTICS_IDLE_TTL_MS),
    Atom.withLabel(`runtime-layer-diagnostics:${environmentKey}`),
  ),
);

export interface RuntimeLayerDiagnosticsState {
  readonly data: ServerRuntimeLayerDiagnosticsResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function formatRuntimeLayerDiagnosticsError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load runtime diagnostics.";
}

function readRuntimeLayerDiagnosticsError(
  result: AsyncResult.AsyncResult<ServerRuntimeLayerDiagnosticsResult, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const squashed = Cause.squash(result.cause);
  return formatRuntimeLayerDiagnosticsError(squashed);
}

export function refreshRuntimeLayerDiagnostics(environmentId = readWorkspaceEnvironmentId()): void {
  appAtomRegistry.refresh(runtimeLayerDiagnosticsAtom(environmentId ?? ""));
}

export function useRuntimeLayerDiagnostics(): RuntimeLayerDiagnosticsState {
  const environmentId = useWorkspaceEnvironmentId();
  const result = useAtomValue(runtimeLayerDiagnosticsAtom(environmentId ?? ""));
  const data = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => {
    refreshRuntimeLayerDiagnostics(environmentId);
  }, [environmentId]);

  return {
    data,
    error: readRuntimeLayerDiagnosticsError(result),
    isPending: result.waiting,
    refresh,
  };
}
