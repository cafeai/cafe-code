import { useLayoutEffect, useRef } from "react";
import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { validCodexContextWindowOverride } from "@cafecode/contracts";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { useStore } from "../../store";
import { requireEnvironmentConnection } from "../../environments/runtime";
import { newCommandId } from "../../lib/utils";

/**
 * Durable server metadata owns saved intent. The only renderer overlay bridges
 * an acknowledged write until this exact chat's context-policy witness catches
 * up; neither another field nor another chat's cursor may retire that bridge.
 */
export function useCodexContextWindowOverride(input: {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly target: ComposerThreadTarget;
  readonly isServerThread: boolean;
  readonly supported: boolean;
}) {
  const latestKey = useRef(input.key);
  latestKey.current = input.key;
  const scopeRef = useRef<{ active: boolean; dispose: (() => void) | null } | null>(null);
  useLayoutEffect(() => {
    if (input.isServerThread && input.threadId) {
      // Reloaded renderer persistence has no surviving ACK owner. Local drafts
      // are different: their stored numeric/reset intent owns first bootstrap.
      useComposerDraftStore.getState().setCodexContextWindowOverride(input.target, undefined);
    }
    const scope = { active: true, dispose: null as (() => void) | null };
    scopeRef.current = scope;
    return () => {
      scope.active = false;
      scope.dispose?.();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [input.key, input.isServerThread, input.threadId, input.target]);

  return async (value: number | null) => {
    if (value !== null && (!input.supported || !validCodexContextWindowOverride(value)))
      throw new Error("Unsupported context override");
    if (latestKey.current !== input.key) throw new Error("Chat selection changed");
    const store = useComposerDraftStore.getState();
    if (!input.isServerThread || !input.threadId) {
      store.setCodexContextWindowOverride(input.target, value);
      return;
    }
    const scope = scopeRef.current;
    if (!scope?.active) throw new Error("Chat no longer active");
    const threadId = input.threadId;
    const readCanonical = () =>
      useStore.getState().environmentStateById[input.environmentId]?.threadShellById[threadId]
        ?.codexContextWindowOverride;
    const readSequence = () =>
      useStore.getState().environmentStateById[input.environmentId]
        ?.codexContextPolicySequenceByThreadId?.[threadId];
    scope.dispose?.();
    let acknowledged: number | null = null;
    let installed = false;
    const dispose = () => {
      unsubscribe();
      if (installed && store.getComposerDraft(input.target)?.codexContextWindowOverride === value)
        store.setCodexContextWindowOverride(input.target, undefined);
      installed = false;
      if (scope.dispose === dispose) scope.dispose = null;
    };
    const unsubscribe = useStore.subscribe(() => {
      const sequence = readSequence();
      if (acknowledged !== null && sequence !== undefined && sequence >= acknowledged) dispose();
    });
    scope.dispose = dispose;
    try {
      // Capture original authority before awaiting; a late ACK never targets a new pane/account.
      const acknowledgement = await requireEnvironmentConnection(
        input.environmentId,
      ).client.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        codexContextWindowOverride: value,
      });
      acknowledged = acknowledgement.sequence;
      const sequence = readSequence();
      if (
        scope.active &&
        scopeRef.current === scope &&
        latestKey.current === input.key &&
        scope.dispose === dispose &&
        (sequence === undefined || sequence < acknowledged) &&
        readCanonical() !== value
      ) {
        installed = true;
        store.setCodexContextWindowOverride(input.target, value);
      }
    } finally {
      if (!installed) dispose();
    }
  };
}
