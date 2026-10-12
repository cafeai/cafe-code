import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import {
  ClipboardIcon,
  FileDownIcon,
  MicIcon,
  PinIcon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS,
  type DictationRewriteTextInput,
  type GlobalDictationInsertionMethod,
  type GlobalDictationGuidance,
  type GlobalDictationEvent,
} from "@cafecode/contracts";

import "./GlobalDictationOverlay.css";
import {
  applyLocalWritingStyle,
  parseOneShotVoiceCommand,
  writingStyleLabels,
  type LocalWritingStyle,
  type WritingStyle,
} from "./writingStyles";

type MaybeAsyncAction = (text: string) => void | boolean | Promise<void | boolean>;
type RewriteStyle =
  | { readonly style: "formal" }
  | { readonly style: "custom"; readonly instructions: string };
type StyleSelection = { readonly style: LocalWritingStyle } | RewriteStyle;

/**
 * Privileged insertion failures carry only this finite, fixed guidance into
 * the review. Accept unknown input at the IPC boundary but never preserve the
 * raw reason: helper errors may otherwise reveal private target text or paths.
 */
export class GlobalDictationInsertError extends Error {
  readonly presentationCode:
    | "target_changed"
    | "target_unavailable"
    | "target_unsupported"
    | "accessibility_permission_required"
    | "clipboard_unavailable"
    | "insertion_uncertain"
    | "unavailable";
  readonly insertionMethod: GlobalDictationInsertionMethod;
  constructor(reason: unknown, insertionMethod: GlobalDictationInsertionMethod = "accessibility") {
    const code =
      reason === "target_changed" ||
      reason === "target_unavailable" ||
      reason === "target_unsupported" ||
      reason === "accessibility_permission_required" ||
      reason === "clipboard_unavailable" ||
      reason === "insertion_uncertain"
        ? reason
        : "unavailable";
    const method = insertionMethod === "paste" ? "paste" : "accessibility";
    super(formatInsertionGuidance(code, method));
    this.presentationCode = code;
    this.insertionMethod = method;
    this.name = "GlobalDictationInsertError";
  }
  /** Keep the finite failure, not a translated string, across language changes.
   * The Error message remains diagnostic data; receipt matching uses no copy. */
  displayMessage(locale: UiLocale): string {
    return formatInsertionGuidance(this.presentationCode, this.insertionMethod, locale);
  }
}

function formatInsertionGuidance(
  reason: GlobalDictationInsertError["presentationCode"],
  insertionMethod: GlobalDictationInsertionMethod,
  locale?: UiLocale,
): string {
  switch (reason) {
    case "target_changed":
      return uiText(
        "The original text or selection changed. Nothing was inserted.",
        undefined,
        undefined,
        locale,
      );
    case "target_unavailable":
      return uiText(
        "The original app or text field is no longer open. Nothing was inserted.",
        undefined,
        undefined,
        locale,
      );
    case "target_unsupported":
      return uiText(
        "That text field doesn''t accept inserted text. Nothing was inserted.",
        undefined,
        undefined,
        locale,
      );
    case "accessibility_permission_required":
      return uiText(
        "Allow Cafe in System Settings → Privacy & Security → Accessibility, then try again. Nothing was inserted.",
        undefined,
        undefined,
        locale,
      );
    case "clipboard_unavailable":
      return uiText(
        "Cafe could not prepare the clipboard. Nothing was pasted.",
        undefined,
        undefined,
        locale,
      );
    case "insertion_uncertain":
      return insertionMethod === "paste"
        ? uiText(
            "Your draft may have been pasted. Check the field before trying again; Cafe will not repeat the paste automatically. The draft may remain on the clipboard.",
            undefined,
            undefined,
            locale,
          )
        : uiText(
            "Insert may have reached the original app. Check that field before trying again; Cafe will not repeat the write automatically.",
            undefined,
            undefined,
            locale,
          );
    default:
      return uiText("Could not insert. Your draft is unchanged.", undefined, undefined, locale);
  }
}

/** New native senders publish a finite hint. Older sender prose is kept opaque
 * rather than reverse-matching English or treating it as target authority. */
export function formatGlobalDictationGuidance(
  guidance: GlobalDictationGuidance,
  locale?: UiLocale,
): string {
  return guidance === "accessibility_permission_required"
    ? uiText(
        "To enable Insert, allow Cafe Code Accessibility in macOS System Settings. You can still Copy or Save.",
        undefined,
        undefined,
        locale,
      )
    : uiText(
        "Insert is unavailable for this field. You can still Copy or Save your draft.",
        undefined,
        undefined,
        locale,
      );
}

export type GlobalDictationStatus =
  | { readonly kind: "connecting" }
  | { readonly kind: "guidance"; readonly code: GlobalDictationGuidance }
  | { readonly kind: "legacy"; readonly text: string };

export function globalDictationStatusFromEvent(
  event: Pick<GlobalDictationEvent, "guidance" | "reason">,
): GlobalDictationStatus | undefined {
  if (
    event.guidance === "accessibility_permission_required" ||
    event.guidance === "target_unavailable"
  ) {
    return { kind: "guidance", code: event.guidance };
  }
  return typeof event.reason === "string" && event.reason.length > 0
    ? { kind: "legacy", text: event.reason }
    : undefined;
}

export function formatGlobalDictationStatus(
  status: GlobalDictationStatus,
  locale?: UiLocale,
): string {
  if (status.kind === "connecting")
    return uiText("Connecting your microphone…", undefined, undefined, locale);
  if (status.kind === "guidance") return formatGlobalDictationGuidance(status.code, locale);
  return status.text;
}

type ReviewFeedback =
  | { readonly kind: "rewrite-ready" | "rewrite-failed"; readonly style: RewriteStyle["style"] }
  | { readonly kind: "rewrite-unavailable" }
  | { readonly kind: "exported"; readonly action: "copy" | "save" }
  | { readonly kind: "action-failed"; readonly action: "copy" | "save" | "insert" }
  | { readonly kind: "insertion"; readonly error: GlobalDictationInsertError };
type CommandFeedback =
  | { readonly kind: "style"; readonly style: WritingStyle }
  | { readonly kind: "custom" | "cancelled" | "unrecognized" | "microphone-failed" };

function formatReviewFeedback(
  feedback: ReviewFeedback,
  labels: Readonly<Record<WritingStyle, string>>,
  locale: UiLocale,
): string {
  switch (feedback.kind) {
    case "rewrite-ready":
      return uiText("{value0} draft ready.", { value0: labels[feedback.style] }, undefined, locale);
    case "rewrite-failed":
      return uiText(
        "{value0} rewrite could not finish. Your draft is unchanged.",
        { value0: labels[feedback.style] },
        undefined,
        locale,
      );
    case "rewrite-unavailable":
      return uiText("Rewriting is unavailable right now.", undefined, undefined, locale);
    case "exported":
      return feedback.action === "copy"
        ? uiText("Copied your draft.", undefined, undefined, locale)
        : uiText("Saved your draft.", undefined, undefined, locale);
    case "insertion":
      return feedback.error.displayMessage(locale);
    case "action-failed":
      return uiText(
        "{kind, select, insert {Could not insert. Your draft is unchanged.} copy {Could not copy. Your draft is unchanged.} other {Could not save. Your draft is unchanged.}}",
        { kind: feedback.action },
        undefined,
        locale,
      );
  }
}

function formatCommandFeedback(
  feedback: CommandFeedback,
  labels: Readonly<Record<WritingStyle, string>>,
  locale: UiLocale,
): string {
  switch (feedback.kind) {
    case "style":
      return uiText(
        "Voice command: {value0}.",
        { value0: labels[feedback.style] },
        undefined,
        locale,
      );
    case "custom":
      return uiText(
        "Custom style captured. Review the instructions, then choose Apply custom style.",
        undefined,
        undefined,
        locale,
      );
    case "cancelled":
      return uiText(
        "Voice command stopped. Your draft is unchanged.",
        undefined,
        undefined,
        locale,
      );
    case "unrecognized":
      return uiText(
        "Command not recognized. Your draft is unchanged.",
        undefined,
        undefined,
        locale,
      );
    case "microphone-failed":
      return uiText(
        "The command microphone could not finish. Your draft is unchanged.",
        undefined,
        undefined,
        locale,
      );
  }
}

export interface GlobalDictationVoiceCommandControl {
  /** Only a finalized, one-shot command belongs here; never a partial transcript. */
  readonly result?: { readonly id: string; readonly transcript: string };
  readonly phase: "idle" | "listening" | "finalizing";
  readonly onStart: () => void | Promise<void>;
  /** Finalization publishes a fresh result, including empty text on capture failure. */
  readonly onStop: () => void | Promise<void>;
}

export interface GlobalDictationOverlayProps {
  /** A new id creates a new immutable review draft, even if the text is identical. */
  readonly sessionId: string;
  readonly phase: "recording" | "finalizing" | "review";
  /** Final transcript. Set before entering review; subsequent streaming is ignored there. */
  readonly transcript: string;
  readonly liveTranscript?: string;
  /** Sanitized desktop status; never pass raw provider output through here. */
  readonly statusMessage?: string;
  /** Sanitized, user-facing error. The current draft remains available. */
  readonly errorMessage?: string;
  readonly shortcutLabel?: string;
  readonly reducedTransparency?: boolean;
  readonly pinned?: boolean;
  readonly onPinChange?: (pinned: boolean) => void;
  readonly onStopRecording: () => void;
  readonly onCancel: () => void;
  readonly onCopy: MaybeAsyncAction;
  readonly onSave: MaybeAsyncAction;
  /** The desktop owner must revalidate the original target before inserting. */
  readonly onInsert: MaybeAsyncAction;
  /** A failed or unsupported target capture still permits Copy and Save. */
  readonly insertAvailable?: boolean;
  /** Presentation of the native capture's method; this prop grants no write authority. */
  readonly insertionMethod?: GlobalDictationInsertionMethod;
  /** An authenticated backend callback. The original transcript leaves the renderer only after consent. */
  readonly rewriteText?: (
    request: DictationRewriteTextInput,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Existing user consent for this optional, separately billed text rewrite. */
  readonly formalConsentGranted?: boolean;
  readonly voiceCommand?: GlobalDictationVoiceCommandControl;
}

/**
 * This renderer never reads the OS focus, clipboard, filesystem or microphone.
 * The desktop owner performs those operations and validates the original target.
 * In particular, showing this review card may focus Cafe, so inserting into
 * "whatever is focused now" would risk sending private text to the wrong app.
 */
export function GlobalDictationOverlay(props: GlobalDictationOverlayProps) {
  const uiLocale = useUiLocale();

  const isRecording = props.phase !== "review";
  return (
    <section
      className="cafe-global-dictation"
      data-phase={props.phase}
      data-reduced-transparency={props.reducedTransparency ? "true" : "false"}
      data-cafe-window-no-drag="true"
      aria-label={uiText("Global dictation", undefined, undefined, uiLocale)}
    >
      <div className="cafe-global-dictation__glass">
        {isRecording ? (
          <RecordingCard {...props} />
        ) : (
          <ReviewCard key={props.sessionId} {...props} />
        )}
      </div>
    </section>
  );
}

function CardChrome(
  props: Pick<GlobalDictationOverlayProps, "onCancel" | "pinned" | "onPinChange">,
) {
  const uiLocale = useUiLocale();

  return (
    <div className="cafe-global-dictation__chrome">
      <button
        type="button"
        className="cafe-global-dictation__icon-button"
        onClick={props.onCancel}
        aria-label={uiText("Close dictation", undefined, undefined, uiLocale)}
      >
        <XIcon aria-hidden="true" size={16} />
      </button>
      <span className="cafe-global-dictation__brand">
        {uiText("Cafe Dictation", undefined, undefined, uiLocale)}
      </span>
      {props.onPinChange ? (
        <button
          type="button"
          className="cafe-global-dictation__icon-button"
          aria-label={
            props.pinned
              ? uiText("Unpin dictation window", undefined, undefined, uiLocale)
              : uiText("Pin dictation window", undefined, undefined, uiLocale)
          }
          aria-pressed={Boolean(props.pinned)}
          onClick={() => props.onPinChange?.(!props.pinned)}
        >
          <PinIcon aria-hidden="true" size={15} />
        </button>
      ) : (
        <span aria-hidden="true" className="cafe-global-dictation__chrome-spacer" />
      )}
    </div>
  );
}

function RecordingCard(props: GlobalDictationOverlayProps) {
  const uiLocale = useUiLocale();

  const finalizing = props.phase === "finalizing";
  return (
    <div className="cafe-global-dictation__recording">
      <CardChrome {...props} />
      <div className="cafe-global-dictation__recording-center">
        <div className="cafe-global-dictation__recording-orb" aria-hidden="true">
          <MicIcon size={20} />
        </div>
        <h1>
          {finalizing
            ? uiText("Finishing your words…", undefined, undefined, uiLocale)
            : uiText("Listening to you", undefined, undefined, uiLocale)}
        </h1>
        <p
          className="cafe-global-dictation__live-transcript"
          aria-label={uiText("Current transcription preview", undefined, undefined, uiLocale)}
        >
          {props.liveTranscript?.trim() ||
            uiText("Your words will appear here…", undefined, undefined, uiLocale)}
        </p>
      </div>
      <div className="cafe-global-dictation__recording-footer">
        <span>
          {props.statusMessage ??
            (finalizing
              ? uiText("Preparing preview", undefined, undefined, uiLocale)
              : uiText(
                  "Press {value0} to review",
                  { value0: props.shortcutLabel ?? "⌘⇧," },
                  undefined,
                  uiLocale,
                ))}
        </span>
        <button
          type="button"
          className="cafe-global-dictation__primary-button"
          disabled={finalizing}
          onClick={props.onStopRecording}
        >
          <SquareIcon size={12} fill="currentColor" aria-hidden="true" />
          {finalizing
            ? uiText("Finishing", undefined, undefined, uiLocale)
            : uiText("Stop & review", undefined, undefined, uiLocale)}
        </button>
      </div>
      {props.errorMessage && (
        <p className="cafe-global-dictation__feedback" role="alert">
          {props.errorMessage}
        </p>
      )}
    </div>
  );
}

function ReviewCard(props: GlobalDictationOverlayProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  // The session key owns this source snapshot. Late transcript props in review
  // cannot change what a local style or an approved rewrite starts from.
  const [original] = useState(props.transcript);
  const usesPaste = props.insertionMethod === "paste";
  const rewriteText = props.rewriteText;
  const [draft, setDraft] = useState(original);
  const [style, setStyle] = useState<WritingStyle>("as-transcribed");
  const [manualEdited, setManualEdited] = useState(false);
  const [pendingStyle, setPendingStyle] = useState<StyleSelection | null>(null);
  const [consentRequest, setConsentRequest] = useState<RewriteStyle | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [formalConsented, setFormalConsented] = useState(Boolean(props.formalConsentGranted));
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<"copy" | "save" | "insert" | null>(null);
  const [feedback, setFeedback] = useState<ReviewFeedback | null>(null);
  const [commandArmed, setCommandArmed] = useState(false);
  const [commandStopping, setCommandStopping] = useState(false);
  const [commandFeedback, setCommandFeedback] = useState<CommandFeedback | null>(null);
  const rewriteRevision = useRef(0);
  const rewriteController = useRef<AbortController | null>(null);
  const commandRevision = useRef(0);
  const processedCommandId = useRef<string | null>(null);
  const actionFeedback = useRef<HTMLParagraphElement | null>(null);
  const customPanel = useRef<HTMLDivElement | null>(null);
  const styleNotice = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (customOpen) customPanel.current?.scrollIntoView({ block: "nearest" });
  }, [customOpen]);

  useEffect(() => {
    if (pendingStyle || consentRequest) styleNotice.current?.scrollIntoView({ block: "nearest" });
  }, [pendingStyle, consentRequest]);

  useEffect(() => {
    // Actions live outside the scrolling pane. Bring their result into view
    // without moving the footer, especially when an uncertain paste needs the
    // user's attention on a display that constrained the native panel's size.
    if (feedback) actionFeedback.current?.scrollIntoView({ block: "nearest" });
  }, [feedback]);

  const cancelRewrite = useCallback(() => {
    rewriteRevision.current += 1;
    rewriteController.current?.abort();
    rewriteController.current = null;
    setRewriteBusy(false);
  }, []);

  useEffect(
    () => () => {
      // A late API response must never overwrite a draft after this card closes.
      rewriteRevision.current += 1;
      rewriteController.current?.abort();
      commandRevision.current += 1;
    },
    [],
  );

  const startRewrite = useCallback(
    async (selection: RewriteStyle) => {
      if (!rewriteText || actionBusy) return;
      cancelRewrite();
      const controller = new AbortController();
      const revision = rewriteRevision.current;
      rewriteController.current = controller;
      setRewriteBusy(true);
      setFeedback(null);
      try {
        const rewritten = await rewriteText(
          { ...selection, text: original, consent: true },
          controller.signal,
        );
        if (controller.signal.aborted || rewriteRevision.current !== revision) return;
        if (!rewritten.trim()) throw new Error("Empty rewrite");
        setDraft(rewritten);
        setStyle(selection.style);
        setManualEdited(false);
        setFeedback({ kind: "rewrite-ready", style: selection.style });
      } catch {
        if (!controller.signal.aborted && rewriteRevision.current === revision) {
          // Do not surface provider error text, which could contain private input.
          setFeedback({ kind: "rewrite-failed", style: selection.style });
        }
      } finally {
        if (rewriteRevision.current === revision) {
          rewriteController.current = null;
          setRewriteBusy(false);
        }
      }
    },
    [actionBusy, cancelRewrite, original, rewriteText],
  );

  const applyStyle = useCallback(
    (selection: StyleSelection) => {
      if (actionBusy) return;
      cancelRewrite();
      setPendingStyle(null);
      setConsentRequest(null);
      setFeedback(null);
      if (selection.style === "formal" || selection.style === "custom") {
        if (!rewriteText) {
          setFeedback({ kind: "rewrite-unavailable" });
          return;
        }
        // Prior Formal consent does not cover new custom instructions. Capture
        // the exact candidate here so later edits cannot change approved input.
        if (selection.style === "custom" || !formalConsented) {
          setConsentRequest(selection);
          return;
        }
        void startRewrite(selection);
        return;
      }
      setDraft(applyLocalWritingStyle(original, selection.style));
      setStyle(selection.style);
      setManualEdited(false);
    },
    [actionBusy, cancelRewrite, formalConsented, original, rewriteText, startRewrite],
  );

  const requestStyle = useCallback(
    (selection: StyleSelection) => {
      if (actionBusy) return;
      cancelRewrite();
      if (manualEdited) {
        setPendingStyle(selection);
        setConsentRequest(null);
        setFeedback(null);
        return;
      }
      applyStyle(selection);
    },
    [actionBusy, applyStyle, cancelRewrite, manualEdited],
  );

  const commandResult = props.voiceCommand?.result;
  useEffect(() => {
    if (!commandArmed || !commandResult || processedCommandId.current === commandResult.id) return;
    processedCommandId.current = commandResult.id;
    commandRevision.current += 1;
    setCommandArmed(false);
    setCommandStopping(false);
    // The capture owner publishes only finalized results and releases its
    // microphone itself. Calling onStop again here could finalize twice.
    const command = parseOneShotVoiceCommand(commandResult.transcript);
    if (command?.type === "style") {
      requestStyle({ style: command.style });
      setCommandFeedback({ kind: "style", style: command.style });
    } else if (command?.type === "custom-style") {
      cancelRewrite();
      setCustomInstructions(command.instructions);
      setCustomOpen(true);
      setPendingStyle(null);
      setConsentRequest(null);
      setCommandFeedback({ kind: "custom" });
    } else if (command?.type === "cancel-command") {
      setCommandFeedback({ kind: "cancelled" });
    } else {
      setCommandFeedback({ kind: "unrecognized" });
    }
  }, [cancelRewrite, commandArmed, commandResult, props.voiceCommand, requestStyle]);

  const toggleCommand = async () => {
    if (!props.voiceCommand || commandStopping || actionBusy) return;
    const revision = commandArmed ? commandRevision.current : ++commandRevision.current;
    setCommandFeedback(null);
    try {
      if (commandArmed) {
        // Stop requests finalization; it does not revoke admission of the
        // result we explicitly recorded. Keep this one shot armed until its
        // fresh finalized result arrives, while preventing duplicate stops.
        setCommandStopping(true);
        await props.voiceCommand.onStop();
      } else {
        // The capture owner may keep the last finalized result in props while
        // it arms a new command. Mark that id as seen before accepting audio.
        processedCommandId.current = props.voiceCommand.result?.id ?? null;
        setCommandArmed(true);
        await props.voiceCommand.onStart();
      }
    } catch {
      // An older start/stop promise can settle after its result was consumed,
      // an export disarmed it, or another one-shot command began.
      if (commandRevision.current !== revision) return;
      commandRevision.current += 1;
      setCommandArmed(false);
      setCommandStopping(false);
      setCommandFeedback({ kind: "microphone-failed" });
    }
  };

  const runAction = async (kind: "copy" | "save" | "insert", action: MaybeAsyncAction) => {
    if (actionBusy || !draft.trim()) return;
    // The click exports the currently reviewed draft. Invalidate outstanding
    // transforms and approvals before crossing that boundary so a delayed
    // result cannot make the displayed draft differ from the exported text.
    // This does not restore insertion authority after Copy or Save.
    cancelRewrite();
    setPendingStyle(null);
    setConsentRequest(null);
    if (commandArmed) {
      commandRevision.current += 1;
      setCommandArmed(false);
      setCommandStopping(false);
      try {
        void Promise.resolve(props.voiceCommand?.onStop()).catch(() => undefined);
      } catch {
        // Export still uses the reviewed text; a late command is now disarmed.
      }
    }
    setActionBusy(kind);
    setFeedback(null);
    try {
      const completed = await action(draft);
      // Native save pickers can be cancelled. Cancellation is neither a save
      // nor an error, and must not display a false "Saved" confirmation.
      if (completed === false) return;
      if (kind !== "insert") setFeedback({ kind: "exported", action: kind });
    } catch (error) {
      if (kind === "insert" && error instanceof GlobalDictationInsertError) {
        setFeedback({ kind: "insertion", error });
        return;
      }
      setFeedback({ kind: "action-failed", action: kind });
    } finally {
      setActionBusy(null);
    }
  };

  const usableDraft = Boolean(draft.trim());
  const commandFinalizing =
    commandStopping || (commandArmed && props.voiceCommand?.phase === "finalizing");
  const requestCancel = () => {
    // A click on the small close affordance should not silently discard a
    // transcript or edits. Recording can close directly; review asks once.
    if (usableDraft || manualEdited) {
      setDiscardConfirm(true);
      return;
    }
    props.onCancel();
  };
  return (
    <div
      className="cafe-global-dictation__review"
      role="dialog"
      aria-modal="false"
      aria-label={uiText("Dictation draft", undefined, undefined, uiLocale)}
    >
      <CardChrome {...props} onCancel={requestCancel} />
      {/* Keep the controls outside this scroll region so a short display,
          expanded original, or consent notice cannot hide the exit/actions. */}
      <div className="cafe-global-dictation__review-body">
        <div className="cafe-global-dictation__draft-heading">
          <label
            className="cafe-global-dictation__field-label"
            htmlFor="cafe-global-dictation-draft"
          >
            {uiText("Editable draft", undefined, undefined, uiLocale)}
          </label>
        </div>
        <textarea
          id="cafe-global-dictation-draft"
          className="cafe-global-dictation__draft"
          // This field only mounts in the explicitly focusable review phase.
          // The passive recording HUD contains no editable focus target.
          autoFocus
          value={draft}
          onChange={(event) => {
            cancelRewrite();
            setDraft(event.target.value);
            setManualEdited(true);
            setPendingStyle(null);
            setConsentRequest(null);
            setFeedback(null);
          }}
          placeholder={uiText("Your transcript is ready to edit…", undefined, undefined, uiLocale)}
          spellCheck
        />
        <div className="cafe-global-dictation__draft-meta">
          <span>
            {manualEdited
              ? uiText("Edited by you", undefined, undefined, uiLocale)
              : style === "as-transcribed"
                ? uiText("Original transcript", undefined, undefined, uiLocale)
                : uiText(
                    "Styled: {value0}",
                    { value0: uiPresentation.writingStyleLabels[style] },
                    undefined,
                    uiLocale,
                  )}
          </span>
          <button
            type="button"
            disabled={Boolean(actionBusy)}
            onClick={() => requestStyle({ style: "as-transcribed" })}
          >
            {uiText("Original / reset", undefined, undefined, uiLocale)}
          </button>
        </div>
        <details className="cafe-global-dictation__original-comparison">
          <summary>{uiText("Compare original transcript", undefined, undefined, uiLocale)}</summary>
          <p>{original || uiText("No transcript was captured.", undefined, undefined, uiLocale)}</p>
        </details>

        <div className="cafe-global-dictation__style-heading">
          <span>{uiText("Writing style", undefined, undefined, uiLocale)}</span>
        </div>
        <div
          className="cafe-global-dictation__styles"
          role="group"
          aria-label={uiText("Writing style", undefined, undefined, uiLocale)}
        >
          {(
            [
              "as-transcribed",
              "lowercase",
              "no-punctuation",
              "lowercase-no-punctuation",
              "formal",
            ] as const
          ).map((option) => (
            <button
              key={option}
              type="button"
              className="cafe-global-dictation__style-chip"
              aria-pressed={style === option && !manualEdited}
              disabled={Boolean(actionBusy) || (option === "formal" && !rewriteText)}
              onClick={() => requestStyle({ style: option })}
            >
              {option === "formal" && <SparklesIcon size={13} aria-hidden="true" />}
              {uiPresentation.writingStyleLabels[option]}
            </button>
          ))}
          <button
            type="button"
            className="cafe-global-dictation__style-chip"
            aria-pressed={style === "custom" && !manualEdited}
            aria-expanded={customOpen}
            aria-controls="cafe-global-dictation-custom-style"
            onClick={() => setCustomOpen((open) => !open)}
          >
            {uiText("Custom", undefined, undefined, uiLocale)}
          </button>
        </div>

        {customOpen && (
          <div
            id="cafe-global-dictation-custom-style"
            className="cafe-global-dictation__custom-style"
            ref={customPanel}
          >
            <label
              className="cafe-global-dictation__field-label"
              htmlFor="cafe-global-dictation-instructions"
            >
              {uiText("Custom style instructions", undefined, undefined, uiLocale)}
            </label>
            <textarea
              id="cafe-global-dictation-instructions"
              className="cafe-global-dictation__custom-instructions"
              aria-describedby="cafe-global-dictation-custom-help"
              maxLength={DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS}
              value={customInstructions}
              onChange={(event) => {
                // Changing instructions revokes an in-flight result and any
                // pending approval for the previous candidate, just like a
                // manual draft edit. Never reinterpret an approved request.
                cancelRewrite();
                setCustomInstructions(event.target.value);
                setPendingStyle(null);
                setConsentRequest(null);
                setFeedback(null);
              }}
              placeholder={uiText(
                "For example: concise, warm, with short sentences",
                undefined,
                undefined,
                uiLocale,
              )}
              rows={3}
            />
            <p id="cafe-global-dictation-custom-help">
              {uiText("Applies to the original transcript.", undefined, undefined, uiLocale)}
            </p>
            <div className="cafe-global-dictation__custom-actions">
              <span>
                {customInstructions.length} / {DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS}
              </span>
              <button
                type="button"
                className="cafe-global-dictation__style-chip"
                disabled={
                  !rewriteText ||
                  rewriteBusy ||
                  Boolean(actionBusy) ||
                  !customInstructions.trim() ||
                  customInstructions.length > DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS
                }
                onClick={() =>
                  requestStyle({ style: "custom", instructions: customInstructions.trim() })
                }
              >
                {uiText("Apply custom style", undefined, undefined, uiLocale)}
              </button>
            </div>
          </div>
        )}

        {pendingStyle && (
          <div ref={styleNotice} className="cafe-global-dictation__notice" role="alert">
            <p>
              <UiMessage
                message={
                  "Applying <slot1></slot1> starts from the original transcript and replaces your manual edits."
                }
                slots={{ slot1: uiPresentation.writingStyleLabels[pendingStyle.style] }}
              />
            </p>
            <div className="cafe-global-dictation__notice-actions">
              <button type="button" onClick={() => setPendingStyle(null)}>
                {uiText("Keep edits", undefined, undefined, uiLocale)}
              </button>
              <button type="button" onClick={() => applyStyle(pendingStyle)}>
                {uiText("Replace draft", undefined, undefined, uiLocale)}
              </button>
            </div>
          </div>
        )}

        {consentRequest && (
          <div ref={styleNotice} className="cafe-global-dictation__notice" role="alert">
            <p>
              {/* Required privacy and billing consent: keep it visible, one line. */}
              {consentRequest.style === "custom"
                ? uiText(
                    "Sends the original transcript and your style instructions to OpenAI for rewriting (uses additional API credits).",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Sends the original transcript to OpenAI for rewriting (uses additional API credits).",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </p>
            <div className="cafe-global-dictation__notice-actions">
              <button type="button" onClick={() => setConsentRequest(null)}>
                {uiText("Not now", undefined, undefined, uiLocale)}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (consentRequest.style === "formal") setFormalConsented(true);
                  setConsentRequest(null);
                  void startRewrite(consentRequest);
                }}
              >
                {uiText("Allow & rewrite", undefined, undefined, uiLocale)}
              </button>
            </div>
          </div>
        )}

        {discardConfirm && (
          <div className="cafe-global-dictation__notice" role="alert">
            <p>
              {uiText(
                "Discard this draft? It hasn''t been inserted or saved.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
            <div className="cafe-global-dictation__notice-actions">
              <button type="button" onClick={() => setDiscardConfirm(false)}>
                {uiText("Keep drafting", undefined, undefined, uiLocale)}
              </button>
              <button type="button" onClick={props.onCancel}>
                {uiText("Discard draft", undefined, undefined, uiLocale)}
              </button>
            </div>
          </div>
        )}

        <div className="cafe-global-dictation__command-row">
          <div>
            <span>{uiText("Voice style command", undefined, undefined, uiLocale)}</span>
            <small>
              {uiText(
                "Say “style lowercase” or “style warm and concise”.",
                undefined,
                undefined,
                uiLocale,
              )}
            </small>
          </div>
          <button
            type="button"
            className="cafe-global-dictation__command-button"
            disabled={
              !props.voiceCommand ||
              rewriteBusy ||
              commandFinalizing ||
              Boolean(actionBusy) ||
              (!commandArmed && props.voiceCommand.phase !== "idle")
            }
            aria-label={
              commandFinalizing
                ? uiText("Finishing voice style command", undefined, undefined, uiLocale)
                : commandArmed
                  ? uiText("Stop voice style command", undefined, undefined, uiLocale)
                  : uiText("Start voice style command", undefined, undefined, uiLocale)
            }
            aria-pressed={commandArmed}
            onClick={() => void toggleCommand()}
          >
            <MicIcon size={17} aria-hidden="true" />
            {commandFinalizing
              ? uiText("Finishing", undefined, undefined, uiLocale)
              : commandArmed
                ? uiText("Listening", undefined, undefined, uiLocale)
                : uiText("Command", undefined, undefined, uiLocale)}
          </button>
        </div>
        {commandFeedback && (
          <p className="cafe-global-dictation__feedback" role="status">
            {formatCommandFeedback(commandFeedback, uiPresentation.writingStyleLabels, uiLocale)}
          </p>
        )}
        {rewriteBusy && (
          <p className="cafe-global-dictation__feedback" role="status">
            {uiText("Refining your draft…", undefined, undefined, uiLocale)}
          </p>
        )}
        {feedback && (
          <p ref={actionFeedback} className="cafe-global-dictation__feedback" role="status">
            {formatReviewFeedback(feedback, uiPresentation.writingStyleLabels, uiLocale)}
          </p>
        )}
        {props.statusMessage && (
          <p className="cafe-global-dictation__feedback" role="status">
            {props.statusMessage}
          </p>
        )}
        {props.errorMessage && (
          <p className="cafe-global-dictation__feedback" role="alert">
            {props.errorMessage}
          </p>
        )}
      </div>

      <div className="cafe-global-dictation__review-footer">
        {usesPaste && (
          <p
            id="cafe-global-dictation-paste-notice"
            className="cafe-global-dictation__paste-notice"
          >
            {uiText(
              "Uses your clipboard briefly. Clipboard-history apps may retain the draft.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        )}
        <button
          type="button"
          className="cafe-global-dictation__quiet-button"
          onClick={requestCancel}
        >
          {uiText("Cancel", undefined, undefined, uiLocale)}
        </button>
        <div className="cafe-global-dictation__review-actions">
          <button
            type="button"
            disabled={!usableDraft || Boolean(actionBusy)}
            onClick={() => void runAction("copy", props.onCopy)}
          >
            <ClipboardIcon size={15} aria-hidden="true" />
            {uiText(" Copy", undefined, undefined, uiLocale)}
          </button>
          <button
            type="button"
            disabled={!usableDraft || Boolean(actionBusy)}
            onClick={() => void runAction("save", props.onSave)}
          >
            <FileDownIcon size={15} aria-hidden="true" />
            {uiText(" Save text…", undefined, undefined, uiLocale)}
          </button>
          <button
            type="button"
            className="cafe-global-dictation__primary-button"
            // The visible clipboard notice above describes this action; no
            // duplicate hover title.
            aria-describedby={usesPaste ? "cafe-global-dictation-paste-notice" : undefined}
            disabled={!usableDraft || Boolean(actionBusy) || props.insertAvailable === false}
            onClick={() => void runAction("insert", props.onInsert)}
          >
            {usesPaste
              ? uiText("Paste into app", undefined, undefined, uiLocale)
              : uiText("Insert", undefined, undefined, uiLocale)}
          </button>
        </div>
      </div>
    </div>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { writingStyleLabels };
