import { useUiLocale } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  DictationTranscriptionModel,
  DictationRewriteTextInput,
  GlobalDictationEvent,
  GlobalDictationInsertionMethod,
  DictationErrorCode,
} from "@cafecode/contracts";
import {
  GlobalDictationInsertError,
  GlobalDictationOverlay,
  globalDictationStatusFromEvent,
  formatGlobalDictationStatus,
  type GlobalDictationStatus,
} from "~/components/global-dictation/GlobalDictationOverlay";
import { formatDictationRpcErrorCode, readDictationRpcErrorCode } from "~/dictation/errors";
import {
  RealtimeTranscriptionError,
  startRealtimeTranscription,
  readRealtimeTranscriptionFeedback,
  formatRealtimeTranscriptionFeedback,
  type RealtimeTranscriptionFeedback,
  type RealtimeTranscriptionSession,
} from "~/dictation/realtimeTranscription";
import { getPrimaryEnvironmentConnection } from "~/environments/runtime";
import { waitForDictationEnvironmentReady } from "./waitForEnvironment";

type Phase = "recording" | "finalizing" | "review";

type DictationFeedback =
  | { readonly kind: "realtime"; readonly feedback: RealtimeTranscriptionFeedback }
  | { readonly kind: "rpc"; readonly code: DictationErrorCode }
  | { readonly kind: "legacy"; readonly text: string }
  | {
      readonly kind:
        | "startup-timeout"
        | "unavailable"
        | "window-disconnected"
        | "voice-microphone-stopped"
        | "stop-failed";
    };

function safeDictationError(error: unknown): DictationFeedback {
  const feedback = readRealtimeTranscriptionFeedback(error);
  if (feedback !== null) return { kind: "realtime", feedback };
  // Legacy locally constructed sanitized errors remain opaque. Do not reverse
  // translate arbitrary received prose or reinterpret it as a discriminator.
  if (error instanceof RealtimeTranscriptionError) return { kind: "legacy", text: error.message };
  if (error instanceof Error && error.message === "dictation_startup_timeout") {
    return { kind: "startup-timeout" };
  }
  const code = readDictationRpcErrorCode(error);
  return code === null ? { kind: "unavailable" } : { kind: "rpc", code };
}

function formatDictationFeedback(feedback: DictationFeedback, locale: UiLocale): string {
  switch (feedback.kind) {
    case "legacy":
      return feedback.text;
    case "realtime":
      return formatRealtimeTranscriptionFeedback(feedback.feedback, locale);
    case "rpc":
      return formatDictationRpcErrorCode(feedback.code, locale);
    case "startup-timeout":
      return uiText(
        "Cafe''s connection took too long. Nothing was inserted; close the review and try again.",
        undefined,
        undefined,
        locale,
      );
    case "unavailable":
      return uiText(
        "Dictation could not continue. Your draft is still here.",
        undefined,
        undefined,
        locale,
      );
    case "window-disconnected":
      return uiText(
        "Could not connect the dictation window. Close it and try again.",
        undefined,
        undefined,
        locale,
      );
    case "voice-microphone-stopped":
      return uiText(
        "The voice command microphone stopped. Your draft is unchanged.",
        undefined,
        undefined,
        locale,
      );
    case "stop-failed":
      return uiText(
        "Could not stop dictation. Use the shortcut or close this window.",
        undefined,
        undefined,
        locale,
      );
  }
}

/**
 * This is a dedicated, auxiliary renderer. It owns only the Realtime audio
 * transport and ephemeral draft; macOS target identity and the privileged
 * actions remain in Electron main. No transcript is placed in the URL,
 * browser storage, console, or the ordinary chat composer.
 */
export function GlobalDictationApp() {
  const uiLocale = useUiLocale();

  useEffect(() => {
    document.title = uiText("Cafe Dictation", undefined, undefined, uiLocale);
  }, [uiLocale]);

  const bridge = window.desktopBridge;
  // The opaque id only correlates this auxiliary renderer with its main-owned
  // session. It is not an authorization token; main also binds exact sender,
  // main frame, and URL before accepting any privileged action.
  const bootSessionId = useRef(new URLSearchParams(window.location.search).get("sessionId"));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("recording");
  const [transcript, setTranscript] = useState("");
  const [errorMessage, setErrorMessage] = useState<DictationFeedback | undefined>();
  const [statusMessage, setStatusMessage] = useState<GlobalDictationStatus | undefined>();
  const [insertAvailable, setInsertAvailable] = useState(false);
  const [insertionMethod, setInsertionMethod] =
    useState<GlobalDictationInsertionMethod>("accessibility");
  const [commandPhase, setCommandPhase] = useState<"idle" | "listening" | "finalizing">("idle");
  const [commandResult, setCommandResult] = useState<{ id: string; transcript: string }>();
  const activeId = useRef<string | null>(null);
  const activePhase = useRef<Phase>("recording");
  const activeTranscript = useRef("");
  const authoritativeTranscript = useRef("");
  const targetGuidance = useRef<GlobalDictationStatus | undefined>(undefined);
  const activeSession = useRef<RealtimeTranscriptionSession | null>(null);
  const activeStart = useRef<Promise<RealtimeTranscriptionSession | null> | null>(null);
  const activeAbort = useRef<AbortController | null>(null);
  const commandSession = useRef<RealtimeTranscriptionSession | null>(null);
  const commandStart = useRef<Promise<RealtimeTranscriptionSession | null> | null>(null);
  const commandAbort = useRef<AbortController | null>(null);
  const commandTranscript = useRef("");
  const commandDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commandStopInFlight = useRef(false);
  const stopInFlight = useRef(false);

  const notifyDesktop = useCallback(
    async (
      action: "ready" | "stop" | "review" | "cancel" | "copy" | "save" | "insert",
      text?: string,
    ) => {
      const id = activeId.current ?? bootSessionId.current;
      if (!id || !bridge?.globalDictationAction) return { ok: false, reason: "unavailable" };
      return await bridge.globalDictationAction({
        sessionId: id,
        action,
        ...(text === undefined ? {} : { text }),
      });
    },
    [bridge],
  );

  const releaseCapture = useCallback(() => {
    if (commandDeadline.current !== null) {
      clearTimeout(commandDeadline.current);
      commandDeadline.current = null;
    }
    activeAbort.current?.abort();
    activeAbort.current = null;
    activeSession.current?.cancel();
    activeSession.current = null;
    commandAbort.current?.abort();
    commandAbort.current = null;
    commandSession.current?.cancel();
    commandSession.current = null;
  }, []);

  const enterReview = useCallback(
    async (id: string, error?: unknown) => {
      if (activeId.current !== id) return;
      activePhase.current = "review";
      // A transport failure can leave partial deltas on screen. Only text
      // observed through completed item events may become an actionable draft.
      setTranscript(authoritativeTranscript.current);
      setPhase("review");
      setStatusMessage(targetGuidance.current);
      if (error !== undefined) setErrorMessage(safeDictationError(error));
      activeSession.current = null;
      await notifyDesktop("review").catch(() => undefined);
    },
    [notifyDesktop],
  );

  const startCapture = useCallback(
    (id: string) => {
      const controller = new AbortController();
      activeAbort.current = controller;
      setStatusMessage({ kind: "connecting" });
      const pending = (async () => {
        try {
          await waitForDictationEnvironmentReady(controller.signal, 15_000);
          if (activeId.current !== id || controller.signal.aborted) return null;
          const client = getPrimaryEnvironmentConnection().client.dictation;
          const session = await startRealtimeTranscription({
            signal: controller.signal,
            getClientSecret: (model: DictationTranscriptionModel) =>
              client.createClientSecret({ model }),
            onTranscript: (snapshot) => {
              if (activeId.current !== id || activePhase.current === "review") return false;
              activeTranscript.current = snapshot.transcript;
              if (snapshot.event.type === "conversation.item.input_audio_transcription.completed") {
                authoritativeTranscript.current = snapshot.transcript;
              }
              setTranscript(snapshot.transcript);
            },
            onFatalError: (error) => {
              if (activeId.current === id) void enterReview(id, error);
            },
          });
          if (activeId.current !== id || controller.signal.aborted) {
            session.cancel();
            return null;
          }
          activeSession.current = session;
          setStatusMessage(targetGuidance.current);
          return session;
        } catch (error) {
          if (activeId.current === id && !controller.signal.aborted) void enterReview(id, error);
          return null;
        }
      })();
      activeStart.current = pending;
    },
    [enterReview],
  );

  const stopCapture = useCallback(async () => {
    const id = activeId.current;
    if (!id || activePhase.current !== "recording" || stopInFlight.current) return;
    stopInFlight.current = true;
    activePhase.current = "finalizing";
    setPhase("finalizing");
    try {
      const session = activeSession.current ?? (await activeStart.current);
      if (activeId.current !== id) return;
      if (session) await session.stopAndFinalize();
      await enterReview(id);
    } catch (error) {
      await enterReview(id, error);
    } finally {
      stopInFlight.current = false;
    }
  }, [enterReview]);

  useEffect(() => {
    if (!bridge?.onGlobalDictationEvent) return;
    const unsubscribe = bridge.onGlobalDictationEvent((event: GlobalDictationEvent) => {
      if (event.type === "start") {
        if (activeId.current !== null) return;
        activeId.current = event.sessionId;
        activePhase.current = "recording";
        setSessionId(event.sessionId);
        setTranscript("");
        activeTranscript.current = "";
        authoritativeTranscript.current = "";
        setErrorMessage(undefined);
        setInsertAvailable(event.insertAvailable === true);
        setInsertionMethod(event.insertionMethod ?? "accessibility");
        targetGuidance.current = globalDictationStatusFromEvent(event);
        if (targetGuidance.current) setStatusMessage(targetGuidance.current);
        startCapture(event.sessionId);
      } else if (event.sessionId === activeId.current && event.type === "stop") {
        void stopCapture();
      } else if (event.sessionId === activeId.current && event.type === "review") {
        if (event.insertAvailable !== undefined) setInsertAvailable(event.insertAvailable);
        if (event.insertionMethod !== undefined) setInsertionMethod(event.insertionMethod);
        const guidance = globalDictationStatusFromEvent(event);
        if (guidance) setStatusMessage(guidance);
      } else if (event.sessionId === activeId.current && event.type === "cancel") {
        releaseCapture();
      }
    });
    void notifyDesktop("ready").catch(() => {
      setErrorMessage({ kind: "window-disconnected" });
    });
    return () => {
      unsubscribe();
      releaseCapture();
    };
  }, [bridge, notifyDesktop, releaseCapture, startCapture, stopCapture]);

  const onCancel = useCallback(() => {
    releaseCapture();
    void notifyDesktop("cancel").catch(() => undefined);
  }, [notifyDesktop, releaseCapture]);

  const runTextAction = useCallback(
    async (action: "copy" | "save" | "insert", text: string): Promise<boolean> => {
      const result = await notifyDesktop(action, text);
      if (!result.ok) {
        if (result.reason === "cancelled") return false;
        if (action === "insert") {
          // This error accepts only finite native failure categories and
          // discards unknown reason text before it can reach review feedback.
          throw new GlobalDictationInsertError(result.reason, insertionMethod);
        }
        throw new Error("The desktop action was not completed.");
      }
      if (action === "insert") releaseCapture();
      if (action !== "insert") setInsertAvailable(false);
      return true;
    },
    [insertionMethod, notifyDesktop, releaseCapture],
  );

  const startCommand = useCallback(async () => {
    if (
      commandSession.current ||
      commandStart.current ||
      commandStopInFlight.current ||
      activePhase.current !== "review"
    ) {
      throw new Error("Voice command microphone unavailable.");
    }
    const id = activeId.current;
    if (!id) throw new Error("Voice command microphone unavailable.");
    const controller = new AbortController();
    commandAbort.current = controller;
    // Review may contain several independent command recordings. Session id
    // alone cannot fence an older start/fatal callback after a new command is
    // armed in that same review; the exact controller owns these mutable refs.
    const ownsCommand = () => activeId.current === id && commandAbort.current === controller;
    commandTranscript.current = "";
    setCommandResult(undefined);
    setCommandPhase("listening");
    commandStart.current = (async () => {
      try {
        await waitForDictationEnvironmentReady(controller.signal, 7_000);
        if (controller.signal.aborted || !ownsCommand()) return null;
        const client = getPrimaryEnvironmentConnection().client.dictation;
        const session = await startRealtimeTranscription({
          signal: controller.signal,
          getClientSecret: (model: DictationTranscriptionModel) =>
            client.createClientSecret({ model }),
          onTranscript: ({ transcript: value, event }) => {
            if (
              ownsCommand() &&
              !controller.signal.aborted &&
              event.type === "conversation.item.input_audio_transcription.completed"
            )
              commandTranscript.current = value;
          },
          onFatalError: () => {
            if (ownsCommand()) {
              controller.abort();
              commandSession.current?.cancel();
              commandSession.current = null;
              commandStart.current = null;
              commandAbort.current = null;
              setErrorMessage({ kind: "voice-microphone-stopped" });
              setCommandResult({ id: crypto.randomUUID(), transcript: "" });
              setCommandPhase("idle");
            }
          },
        });
        if (controller.signal.aborted || !ownsCommand()) {
          session.cancel();
          return null;
        }
        commandSession.current = session;
        return session;
      } catch {
        if (ownsCommand()) setCommandPhase("idle");
        return null;
      }
    })();
    const started = await commandStart.current;
    if (!started) {
      if (ownsCommand()) {
        controller.abort();
        commandStart.current = null;
        commandAbort.current = null;
        setCommandPhase("idle");
      }
      throw new Error("Voice command microphone unavailable.");
    }
  }, []);

  const stopCommand = useCallback(async () => {
    const id = activeId.current;
    // A manual stop can coincide with the seven-second deadline. There is one
    // finalization and one result per armed capture, never a second finalize.
    if (!id || commandStopInFlight.current) return;
    commandStopInFlight.current = true;
    const controller = commandAbort.current;
    let finalizedTranscript = "";
    setCommandPhase("finalizing");
    if (commandDeadline.current !== null) {
      clearTimeout(commandDeadline.current);
      commandDeadline.current = null;
    }
    try {
      const session = commandSession.current ?? (await commandStart.current);
      if (session) await session.stopAndFinalize();
      if (!controller?.signal.aborted) finalizedTranscript = commandTranscript.current;
    } catch {
      // A failed command still publishes a terminal, empty result below so
      // review cannot remain armed indefinitely or accept a later stale result.
    } finally {
      if (activeId.current === id && commandAbort.current === controller) {
        controller?.abort();
        commandSession.current?.cancel();
        commandSession.current = null;
        commandStart.current = null;
        commandAbort.current = null;
        setCommandResult({ id: crypto.randomUUID(), transcript: finalizedTranscript });
        setCommandPhase("idle");
      }
      commandStopInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (commandPhase !== "listening") return;
    // A voice style command is a short, deliberately armed utterance, never an
    // unattended background mic. A bounded deadline also handles silence.
    commandDeadline.current = setTimeout(() => void stopCommand(), 7_000);
    return () => {
      if (commandDeadline.current !== null) {
        clearTimeout(commandDeadline.current);
        commandDeadline.current = null;
      }
    };
  }, [commandPhase, stopCommand]);

  const rewriteText = useCallback(
    async (request: DictationRewriteTextInput, signal: AbortSignal) => {
      await waitForDictationEnvironmentReady(signal, 15_000);
      if (signal.aborted) throw new Error("cancelled");
      const rewritten =
        await getPrimaryEnvironmentConnection().client.dictation.rewriteText(request);
      if (signal.aborted) throw new Error("cancelled");
      return rewritten.text;
    },
    [],
  );

  if (!sessionId) return null;
  return (
    <GlobalDictationOverlay
      sessionId={sessionId}
      phase={phase}
      transcript={transcript}
      liveTranscript={transcript}
      {...(statusMessage === undefined
        ? {}
        : { statusMessage: formatGlobalDictationStatus(statusMessage, uiLocale) })}
      {...(errorMessage === undefined
        ? {}
        : { errorMessage: formatDictationFeedback(errorMessage, uiLocale) })}
      insertAvailable={insertAvailable}
      insertionMethod={insertionMethod}
      onStopRecording={() => {
        void notifyDesktop("stop").catch(() => {
          setErrorMessage({ kind: "stop-failed" });
        });
      }}
      onCancel={onCancel}
      onCopy={(text) => runTextAction("copy", text)}
      onSave={(text) => runTextAction("save", text)}
      onInsert={(text) => runTextAction("insert", text)}
      rewriteText={rewriteText}
      voiceCommand={{
        phase: commandPhase,
        ...(commandResult ? { result: commandResult } : {}),
        onStart: startCommand,
        onStop: stopCommand,
      }}
    />
  );
}

export function mountGlobalDictation(element: HTMLElement): void {
  document.title = uiText("Cafe Dictation");
  createRoot(element).render(<GlobalDictationApp />);
}
