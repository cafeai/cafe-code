import type { DictationRealtimeClientSecret } from "@cafecode/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  formatComposerDictationInsertion,
  RealtimeTranscriptionError,
  startRealtimeTranscription,
  type RealtimeTranscriptionSession,
} from "~/dictation/realtimeTranscription";

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
  readonly createClientSecret: () => Promise<DictationRealtimeClientSecret>;
  readonly readComposerSnapshot: () => ComposerSnapshot;
  readonly replaceComposerRange: (input: ReplaceComposerRangeInput) => boolean;
  readonly onError: (message: string) => void;
}

interface ScopedPhase {
  readonly sessionKey: string;
  readonly phase: ComposerDictationPhase;
}

const DICTATION_RPC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  insecure_transport: "Dictation requires HTTPS or a same-machine Cafe connection.",
  not_authorized: "This Cafe connection is not allowed to start dictation.",
  not_configured: "Dictation is not configured on this Cafe server.",
  rate_limited: "Dictation was started too frequently. Please wait a moment and try again.",
  secret_store_failed: "Cafe could not access the saved dictation credential.",
  upstream_auth_failed: "OpenAI rejected the saved dictation credential.",
  upstream_invalid_response: "OpenAI returned an invalid dictation session response.",
  upstream_rate_limited: "OpenAI is rate limiting dictation. Please try again shortly.",
  upstream_unavailable: "Cafe could not reach OpenAI to start dictation.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convert all transport/RPC failures to fixed strings safe for a user toast. */
export function formatComposerDictationError(error: unknown): string {
  if (error instanceof RealtimeTranscriptionError) return error.message;
  if (isRecord(error) && typeof error.code === "string") {
    return DICTATION_RPC_ERROR_MESSAGES[error.code] ?? "Cafe could not start dictation.";
  }
  return "Cafe could not start dictation.";
}

export interface ComposerDictationController {
  readonly phase: ComposerDictationPhase;
  readonly isEditingLocked: boolean;
  readonly statusMessage: string;
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

  const start = useCallback(async () => {
    const currentInput = inputRef.current;
    if (
      !currentInput.enabled ||
      phaseRef.current === "starting" ||
      phaseRef.current === "recording" ||
      phaseRef.current === "finalizing"
    ) {
      return;
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
        return;
      }
      pendingStartAbortRef.current = null;
      sessionRef.current = session;
      transition(sessionKey, "recording");
    } catch (error) {
      if (generationRef.current !== generation) return;
      pendingStartAbortRef.current = null;
      sessionRef.current = null;
      ownedRangeRef.current = null;
      if (error instanceof RealtimeTranscriptionError && error.code === "cancelled") {
        transition(sessionKey, "idle");
        return;
      }
      transition(sessionKey, "error");
      reportErrorOnce(generation, error);
    }
  }, [reportErrorOnce, transition]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || phaseRef.current !== "recording") return;

    const generation = generationRef.current;
    const sessionKey = inputRef.current.sessionKey;
    transition(sessionKey, "finalizing");
    try {
      await session.stopAndFinalize();
      if (generationRef.current !== generation) return;
      sessionRef.current = null;
      ownedRangeRef.current = null;
      transition(sessionKey, "idle");
    } catch (error) {
      if (generationRef.current !== generation) return;
      sessionRef.current = null;
      ownedRangeRef.current = null;
      transition(sessionKey, "error");
      reportErrorOnce(generation, error);
    }
  }, [reportErrorOnce, transition]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "recording") {
      void stop();
      return;
    }
    if (phaseRef.current === "idle" || phaseRef.current === "error") {
      void start();
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
    toggle,
  };
}
