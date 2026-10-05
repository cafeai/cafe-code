import { useAtomValue } from "@effect/atom-react";
import type {
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryResult,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { EnvironmentId } from "@cafecode/contracts";
import { ensureWorkspaceApi } from "../environments/workspaceApi";
import { readWorkspaceEnvironmentId, useWorkspaceEnvironmentId } from "../environments/workspace";
import { appAtomRegistry } from "../rpc/atomRegistry";

const PROCESS_DIAGNOSTICS_STALE_TIME_MS = 2_000;
const PROCESS_DIAGNOSTICS_IDLE_TTL_MS = 5 * 60_000;
const PROCESS_RESOURCE_HISTORY_STALE_TIME_MS = 5_000;

const processDiagnosticsAtom = Atom.family((environmentKey: string) =>
  Atom.make(
    Effect.promise(() =>
      ensureWorkspaceApi(
        environmentKey ? EnvironmentId.make(environmentKey) : null,
      ).server.getProcessDiagnostics(),
    ),
  ).pipe(
    Atom.swr({
      staleTime: PROCESS_DIAGNOSTICS_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PROCESS_DIAGNOSTICS_IDLE_TTL_MS),
    Atom.withLabel(`process-diagnostics:${environmentKey}`),
  ),
);

function formatProcessResourceHistoryKey(
  environmentId: EnvironmentId | null,
  input: {
    readonly windowMs: number;
    readonly bucketMs: number;
  },
): string {
  return JSON.stringify([environmentId, input.windowMs, input.bucketMs]);
}

function parseProcessResourceHistoryKey(key: string): {
  environmentId: EnvironmentId | null;
  windowMs: number;
  bucketMs: number;
} {
  const [id, windowMs, bucketMs] = JSON.parse(key) as [EnvironmentId | null, number, number];
  return { environmentId: id, windowMs, bucketMs };
}

const processResourceHistoryAtom = Atom.family((key: string) => {
  const input = parseProcessResourceHistoryKey(key);
  return Atom.make(
    Effect.promise(() =>
      ensureWorkspaceApi(input.environmentId).server.getProcessResourceHistory({
        windowMs: input.windowMs,
        bucketMs: input.bucketMs,
      }),
    ),
  ).pipe(
    Atom.swr({
      staleTime: PROCESS_RESOURCE_HISTORY_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PROCESS_DIAGNOSTICS_IDLE_TTL_MS),
    Atom.withLabel(`process-resource-history:${key}`),
  );
});

export interface ProcessDiagnosticsState {
  readonly data: ServerProcessDiagnosticsResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export interface ProcessResourceHistoryState {
  readonly data: ServerProcessResourceHistoryResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function formatProcessDiagnosticsError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load process diagnostics.";
}

function readProcessDiagnosticsError(
  result: AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const squashed = Cause.squash(result.cause);
  return formatProcessDiagnosticsError(squashed);
}

function readProcessResourceHistoryError(
  result: AsyncResult.AsyncResult<ServerProcessResourceHistoryResult, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const squashed = Cause.squash(result.cause);
  return formatProcessDiagnosticsError(squashed);
}

export function refreshProcessDiagnostics(environmentId = readWorkspaceEnvironmentId()): void {
  appAtomRegistry.refresh(processDiagnosticsAtom(environmentId ?? ""));
}

export function useProcessDiagnostics(): ProcessDiagnosticsState {
  const environmentId = useWorkspaceEnvironmentId();
  const result = useAtomValue(processDiagnosticsAtom(environmentId ?? ""));
  const data = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => {
    refreshProcessDiagnostics(environmentId);
  }, [environmentId]);

  return {
    data,
    error: readProcessDiagnosticsError(result),
    isPending: result.waiting,
    refresh,
  };
}

export function useProcessResourceHistory(input: {
  readonly windowMs: number;
  readonly bucketMs: number;
}): ProcessResourceHistoryState {
  const environmentId = useWorkspaceEnvironmentId();
  const atom = processResourceHistoryAtom(formatProcessResourceHistoryKey(environmentId, input));
  const result = useAtomValue(atom);
  const data = Option.getOrNull(AsyncResult.value(result));

  const refresh = useCallback(() => {
    appAtomRegistry.refresh(atom);
  }, [atom]);

  return {
    data,
    error: readProcessResourceHistoryError(result),
    isPending: result.waiting,
    refresh,
  };
}
