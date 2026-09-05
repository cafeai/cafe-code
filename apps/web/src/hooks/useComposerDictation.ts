import type {
  DictationRealtimeClientSecret,
  DictationTranscriptionModel,
} from "@cafecode/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  formatComposerDictationInsertion,
  RealtimeTranscriptionError,
  startRealtimeTranscription,
  type RealtimeTranscriptionSession,
} from "~/dictation/realtimeTranscription";
import { formatDictationRpcError } from "~/dictation/errors";

export type ComposerDictationPhase = "error" | "finalizing" | "idle" | "recording" | "starting";

interface ComposerSnapshot {
  readonly value: string;
  readonly expandedCursor: number;
}

interface ComposerDictationOwnedRange {
  readonly start: number;
  readonly originalPrompt: string;
  renderedText: string;
}

interface ReplaceComposerRangeInput {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly expectedText: string;
}

interface UseComposerDictationInput {
  readonly enabled: boolean;
  readonly sessionKey: string;
  readonly createClientSecret: (
    model: DictationTranscriptionModel,
  ) => Promise<DictationRealtimeClientSecret>;
  readonly readComposerSnapshot: () => ComposerSnapshot;
  readonly replaceComposerRange: (input: ReplaceComposerRangeInput) => boolean;
  readonly onError: (message: string) => void;
}

interface ScopedPhase {
  readonly sessionKey: string;
  readonly phase: ComposerDictationPhase;
}

/** Convert all transport/RPC failures to fixed strings safe for a user toast. */
export function formatComposerDictationError(error: unknown): string {
  if (error instanceof RealtimeTranscriptionError) return error.message;
  return formatDictationRpcError(error) ?? "Cafe could not start dictation.";
}

export interface ComposerDictationController {
  readonly phase: ComposerDictationPhase;
  readonly isEditingLocked: boolean;
  readonly statusMessage: string;
  /**
   * Finish any in-flight startup or recording and wait until the final,
   * authoritative transcript has been applied to the composer. A false result
   * means startup/finalization failed or the session was invalidated, so a
   * caller must not submit the interim text that happened to be visible.
   */
  readonly finish: () => Promise<boolean>;
  readonly toggle: () => void;
}

/**
 * Own exactly one transcript range and one media session for the active
 * composer route. Locking ordinary edits while recording makes each interim
 * replacement mechanically safe: expectedText must
 * match before Cafe changes the prompt, otherwise capture stops without
 * overwriting user or provider state.
 */
export function useComposerDictation(
  input: UseComposerDictationInput,
): ComposerDictationController {
  const inputRef = useRef(input);
  inputRef.current = input;

  const [scopedPhase, setScopedPhase] = useState<ScopedPhase>({
    sessionKey: input.sessionKey,
    phase: "idle",
  });
  const phaseRef = useRef<ComposerDictationPhase>("idle");
  const generationRef = useRef(0);
  const sessionRef = useRef<RealtimeTranscriptionSession | null>(null);
  const pendingStartAbortRef = useRef<AbortController | null>(null);
  const pendingStartPromiseRef = useRef<Promise<boolean> | null>(null);
  const pendingFinalizationPromiseRef = useRef<Promise<boolean> | null>(null);
  const ownedRangeRef = useRef<ComposerDictationOwnedRange | null>(null);
  const reportedErrorGenerationRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const transition = useCallback((sessionKey: string, phase: ComposerDictationPhase) => {
    phaseRef.current = phase;
    if (mountedRef.current) setScopedPhase({ sessionKey, phase });
  }, []);

  const cancelActiveSession = useCallback(() => {
    generationRef.current += 1;
    pendingStartAbortRef.current?.abort();
    pendingStartAbortRef.current = null;
    pendingStartPromiseRef.current = null;
    pendingFinalizationPromiseRef.current = null;
    sessionRef.current?.cancel();
    sessionRef.current = null;
    ownedRangeRef.current = null;
    reportedErrorGenerationRef.current = null;
    phaseRef.current = "idle";
  }, []);

  const reportErrorOnce = useCallback((generation: number, error: unknown) => {
    if (reportedErrorGenerationRef.current === generation) return;
    reportedErrorGenerationRef.current = generation;
    inputRef.current.onError(formatComposerDictationError(error));
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    const currentInput = inputRef.current;
    if (
      !currentInput.enabled ||
      phaseRef.current === "starting" ||
      phaseRef.current === "recording" ||
      phaseRef.current === "finalizing"
    ) {
      return false;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    reportedErrorGenerationRef.current = null;
    const sessionKey = currentInput.sessionKey;
    const snapshot = currentInput.readComposerSnapshot();
    const insertionOffset = Math.max(0, Math.min(snapshot.value.length, snapshot.expandedCursor));
    ownedRangeRef.current = {
      start: insertionOffset,
      originalPrompt: snapshot.value,
      renderedText: "",
    };

    const abortController = new AbortController();
    pendingStartAbortRef.current = abortController;
    transition(sessionKey, "starting");

    try {
      const session = await startRealtimeTranscription({
        signal: abortController.signal,
        getClientSecret: currentInput.createClientSecret,
        onTranscript: ({ transcript }) => {
          if (generationRef.current !== generation) return true;
          const ownedRange = ownedRangeRef.current;
          if (!ownedRange) return false;

          const nextRenderedText = formatComposerDictationInsertion(
            ownedRange.originalPrompt,
            ownedRange.start,
            transcript,
          );
          if (nextRenderedText === ownedRange.renderedText) return true;

          const replaced = inputRef.current.replaceComposerRange({
            start: ownedRange.start,
            end: ownedRange.start + ownedRange.renderedText.length,
            replacement: nextRenderedText,
            expectedText: ownedRange.renderedText,
          });
          if (replaced) ownedRange.renderedText = nextRenderedText;
          return replaced;
        },
        onFatalError: (error) => {
          if (generationRef.current !== generation) return;
          sessionRef.current = null;
          pendingStartAbortRef.current = null;
          ownedRangeRef.current = null;
          transition(sessionKey, "error");
          reportErrorOnce(generation, error);
        },
      });

      if (generationRef.current !== generation || abortController.signal.aborted) {
        session.cancel();
        return false;
      }
      pendingStartAbortRef.current = null;
      sessionRef.current = session;
      transition(sessionKey, "recording");
      return true;
    } catch (error) {
      if (generationRef.current !== generation) return false;
      pendingStartAbortRef.current = null;
      sessionRef.current = null;
      ownedRangeRef.current = null;
      if (error instanceof RealtimeTranscriptionError && error.code === "cancelled") {
        transition(sessionKey, "idle");
        return false;
      }
      transition(sessionKey, "error");
      reportErrorOnce(generation, error);
      return false;
    }
  }, [reportErrorOnce, transition]);

  const stop = useCallback((): Promise<boolean> => {
    if (phaseRef.current === "finalizing") {
      return pendingFinalizationPromiseRef.current ?? Promise.resolve(false);
    }

    const session = sessionRef.current;
    if (!session || phaseRef.current !== "recording") {
      return Promise.resolve(phaseRef.current === "idle");
    }

    const generation = generationRef.current;
    const sessionKey = inputRef.current.sessionKey;
    transition(sessionKey, "finalizing");
    const operation = (async (): Promise<boolean> => {
      try {
        await session.stopAndFinalize();
        if (generationRef.current !== generation) return false;
        sessionRef.current = null;
        ownedRangeRef.current = null;
        transition(sessionKey, "idle");
        return true;
      } catch (error) {
        if (generationRef.current !== generation) return false;
        sessionRef.current = null;
        ownedRangeRef.current = null;
        transition(sessionKey, "error");
        reportErrorOnce(generation, error);
        return false;
      }
    })();
    pendingFinalizationPromiseRef.current = operation;
    const clearOperation = () => {
      if (pendingFinalizationPromiseRef.current === operation) {
        pendingFinalizationPromiseRef.current = null;
      }
    };
    // Both handlers deliberately consume the settlement. The operation itself
    // is already sanitized to a boolean, but this also prevents a future
    // refactor from turning this fire-and-forget cleanup into an unhandled
    // rejection.
    void operation.then(clearOperation, clearOperation);
    return operation;
  }, [reportErrorOnce, transition]);

  const finish = useCallback(async (): Promise<boolean> => {
    const generation = generationRef.current;

    if (phaseRef.current === "starting") {
      const pendingStart = pendingStartPromiseRef.current;
      if (!pendingStart || !(await pendingStart)) return false;
      // A route/configuration change cancels the prior generation. Never let a
      // delayed Send action submit text owned by that invalidated session.
      if (generationRef.current !== generation) return false;
    }

    if (phaseRef.current === "recording") {
      return stop();
    }
    if (phaseRef.current === "finalizing") {
      return pendingFinalizationPromiseRef.current ?? false;
    }
    return phaseRef.current === "idle";
  }, [stop]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "recording") {
      void stop();
      return;
    }
    if (phaseRef.current === "idle" || phaseRef.current === "error") {
      const operation = start();
      pendingStartPromiseRef.current = operation;
      const clearOperation = () => {
        if (pendingStartPromiseRef.current === operation) {
          pendingStartPromiseRef.current = null;
        }
      };
      void operation.then(clearOperation, clearOperation);
    }
  }, [start, stop]);

  // A route/configuration change invalidates both the owned text range and the
  // ephemeral credential. Cleanup does not mutate React state during unmount;
  // the scoped rendering logic below exposes idle immediately for a new key.
  useLayoutEffect(() => {
    return cancelActiveSession;
  }, [cancelActiveSession, input.enabled, input.sessionKey]);

  useEffect(() => {
    mountedRef.current = true;
    const handlePageHide = () => {
      cancelActiveSession();
      transition(inputRef.current.sessionKey, "idle");
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", handlePageHide);
      cancelActiveSession();
    };
  }, [cancelActiveSession, transition]);

  const phase =
    input.enabled && scopedPhase.sessionKey === input.sessionKey && phaseRef.current !== "idle"
      ? scopedPhase.phase
      : "idle";

  return {
    phase,
    isEditingLocked: phase === "starting" || phase === "recording" || phase === "finalizing",
    statusMessage:
      phase === "starting"
        ? "Connecting microphone"
        : phase === "recording"
          ? "Listening"
          : phase === "finalizing"
            ? "Finishing dictation"
            : phase === "error"
              ? "Dictation stopped"
              : "Dictation ready",
    finish,
    toggle,
  };
}
