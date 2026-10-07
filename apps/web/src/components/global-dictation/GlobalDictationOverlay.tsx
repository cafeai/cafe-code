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
  constructor(reason: unknown, insertionMethod: GlobalDictationInsertionMethod = "accessibility") {
    let message: string;
    switch (reason) {
      case "target_changed":
        message = "The original text or selection changed. Nothing was inserted.";
        break;
      case "target_unavailable":
        message = "The original app or text field is no longer open. Nothing was inserted.";
        break;
      case "target_unsupported":
        message = "That text field doesn't accept inserted text. Nothing was inserted.";
        break;
      case "accessibility_permission_required":
        message =
          "Allow Cafe in System Settings → Privacy & Security → Accessibility, then try again. Nothing was inserted.";
        break;
      case "clipboard_unavailable":
        message = "Cafe could not prepare the clipboard. Nothing was pasted.";
        break;
      case "insertion_uncertain":
        message =
          insertionMethod === "paste"
            ? "Your draft may have been pasted. Check the field before trying again; Cafe will not repeat the paste automatically. The draft may remain on the clipboard."
            : "Insert may have reached the original app. Check that field before trying again; Cafe will not repeat the write automatically.";
        break;
      default:
        message = "Could not insert. Your draft is unchanged.";
    }
    super(message);
    this.name = "GlobalDictationInsertError";
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
  const isRecording = props.phase !== "review";
  return (
    <section
      className="cafe-global-dictation"
      data-phase={props.phase}
      data-reduced-transparency={props.reducedTransparency ? "true" : "false"}
      data-cafe-window-no-drag="true"
      aria-label="Global dictation"
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
  return (
    <div className="cafe-global-dictation__chrome">
      <button
        type="button"
        className="cafe-global-dictation__icon-button"
        onClick={props.onCancel}
        aria-label="Close dictation"
      >
        <XIcon aria-hidden="true" size={16} />
      </button>
      <span className="cafe-global-dictation__brand">Cafe Dictation</span>
      {props.onPinChange ? (
        <button
          type="button"
          className="cafe-global-dictation__icon-button"
          aria-label={props.pinned ? "Unpin dictation window" : "Pin dictation window"}
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
  const finalizing = props.phase === "finalizing";
  return (
    <div className="cafe-global-dictation__recording">
      <CardChrome {...props} />
      <div className="cafe-global-dictation__recording-center">
        <div className="cafe-global-dictation__recording-orb" aria-hidden="true">
          <MicIcon size={20} />
        </div>
        <h1>{finalizing ? "Finishing your words…" : "Listening to you"}</h1>
        <p
          className="cafe-global-dictation__live-transcript"
          aria-label="Current transcription preview"
        >
          {props.liveTranscript?.trim() || "Your words will appear here…"}
        </p>
      </div>
      <div className="cafe-global-dictation__recording-footer">
        <span>
          {props.statusMessage ??
            (finalizing ? "Preparing preview" : `Press ${props.shortcutLabel ?? "⌘⇧,"} to review`)}
        </span>
        <button
          type="button"
          className="cafe-global-dictation__primary-button"
          disabled={finalizing}
          onClick={props.onStopRecording}
        >
          <SquareIcon size={12} fill="currentColor" aria-hidden="true" />
          {finalizing ? "Finishing" : "Stop & review"}
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
  const [feedback, setFeedback] = useState<string | null>(null);
  const [commandArmed, setCommandArmed] = useState(false);
  const [commandStopping, setCommandStopping] = useState(false);
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
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
        setFeedback(`${writingStyleLabels[selection.style]} draft ready.`);
      } catch {
        if (!controller.signal.aborted && rewriteRevision.current === revision) {
          // Do not surface provider error text, which could contain private input.
          setFeedback(
            `${writingStyleLabels[selection.style]} rewrite could not finish. Your draft is unchanged.`,
          );
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
          setFeedback("Rewriting is unavailable right now.");
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
      setCommandFeedback(`Voice command: ${writingStyleLabels[command.style]}.`);
    } else if (command?.type === "custom-style") {
      cancelRewrite();
      setCustomInstructions(command.instructions);
      setCustomOpen(true);
      setPendingStyle(null);
      setConsentRequest(null);
      setCommandFeedback(
        "Custom style captured. Review the instructions, then choose Apply custom style.",
      );
    } else if (command?.type === "cancel-command") {
      setCommandFeedback("Voice command stopped. Your draft is unchanged.");
    } else {
      setCommandFeedback("Command not recognized. Your draft is unchanged.");
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
      setCommandFeedback("The command microphone could not finish. Your draft is unchanged.");
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
      if (kind !== "insert")
        setFeedback(kind === "copy" ? "Copied your draft." : "Saved your draft.");
    } catch (error) {
      if (kind === "insert" && error instanceof GlobalDictationInsertError) {
        setFeedback(error.message);
        return;
      }
      setFeedback(
        `${kind === "insert" ? "Could not insert" : kind === "copy" ? "Could not copy" : "Could not save"}. Your draft is unchanged.`,
      );
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
      aria-label="Dictation draft"
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
            Editable draft
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
          placeholder="Your transcript is ready to edit…"
          spellCheck
        />
        <div className="cafe-global-dictation__draft-meta">
          <span>
            {manualEdited
              ? "Edited by you"
              : style === "as-transcribed"
                ? "Original transcript"
                : `Styled: ${writingStyleLabels[style]}`}
          </span>
          <button
            type="button"
            disabled={Boolean(actionBusy)}
            onClick={() => requestStyle({ style: "as-transcribed" })}
          >
            Original / reset
          </button>
        </div>
        <details className="cafe-global-dictation__original-comparison">
          <summary>Compare original transcript</summary>
          <p>{original || "No transcript was captured."}</p>
        </details>

        <div className="cafe-global-dictation__style-heading">
          <span>Writing style</span>
        </div>
        <div className="cafe-global-dictation__styles" role="group" aria-label="Writing style">
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
              {writingStyleLabels[option]}
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
            Custom
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
              Custom style instructions
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
              placeholder="For example: concise, warm, with short sentences"
              rows={3}
            />
            <p id="cafe-global-dictation-custom-help">Applies to the original transcript.</p>
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
                Apply custom style
              </button>
            </div>
          </div>
        )}

        {pendingStyle && (
          <div ref={styleNotice} className="cafe-global-dictation__notice" role="alert">
            <p>
              Applying {writingStyleLabels[pendingStyle.style]} starts from the original transcript
              and replaces your manual edits.
            </p>
            <div className="cafe-global-dictation__notice-actions">
              <button type="button" onClick={() => setPendingStyle(null)}>
                Keep edits
              </button>
              <button type="button" onClick={() => applyStyle(pendingStyle)}>
                Replace draft
              </button>
            </div>
          </div>
        )}

        {consentRequest && (
          <div ref={styleNotice} className="cafe-global-dictation__notice" role="alert">
            <p>
              {/* Required privacy and billing consent: keep it visible, one line. */}
              {consentRequest.style === "custom"
                ? "Sends the original transcript and your style instructions to OpenAI for rewriting (uses additional API credits)."
                : "Sends the original transcript to OpenAI for rewriting (uses additional API credits)."}
            </p>
            <div className="cafe-global-dictation__notice-actions">
              <button type="button" onClick={() => setConsentRequest(null)}>
                Not now
              </button>
              <button
                type="button"
                onClick={() => {
                  if (consentRequest.style === "formal") setFormalConsented(true);
                  setConsentRequest(null);
                  void startRewrite(consentRequest);
                }}
              >
                Allow & rewrite
              </button>
            </div>
          </div>
        )}

        {discardConfirm && (
          <div className="cafe-global-dictation__notice" role="alert">
            <p>Discard this draft? It hasn't been inserted or saved.</p>
            <div className="cafe-global-dictation__notice-actions">
              <button type="button" onClick={() => setDiscardConfirm(false)}>
                Keep drafting
              </button>
              <button type="button" onClick={props.onCancel}>
                Discard draft
              </button>
            </div>
          </div>
        )}

        <div className="cafe-global-dictation__command-row">
          <div>
            <span>Voice style command</span>
            <small>Say “style lowercase” or “style warm and concise”.</small>
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
                ? "Finishing voice style command"
                : commandArmed
                  ? "Stop voice style command"
                  : "Start voice style command"
            }
            aria-pressed={commandArmed}
            onClick={() => void toggleCommand()}
          >
            <MicIcon size={17} aria-hidden="true" />
            {commandFinalizing ? "Finishing" : commandArmed ? "Listening" : "Command"}
          </button>
        </div>
        {commandFeedback && (
          <p className="cafe-global-dictation__feedback" role="status">
            {commandFeedback}
          </p>
        )}
        {rewriteBusy && (
          <p className="cafe-global-dictation__feedback" role="status">
            Refining your draft…
          </p>
        )}
        {feedback && (
          <p ref={actionFeedback} className="cafe-global-dictation__feedback" role="status">
            {feedback}
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
            Uses your clipboard briefly. Clipboard-history apps may retain the draft.
          </p>
        )}
        <button
          type="button"
          className="cafe-global-dictation__quiet-button"
          onClick={requestCancel}
        >
          Cancel
        </button>
        <div className="cafe-global-dictation__review-actions">
          <button
            type="button"
            disabled={!usableDraft || Boolean(actionBusy)}
            onClick={() => void runAction("copy", props.onCopy)}
          >
            <ClipboardIcon size={15} aria-hidden="true" /> Copy
          </button>
          <button
            type="button"
            disabled={!usableDraft || Boolean(actionBusy)}
            onClick={() => void runAction("save", props.onSave)}
          >
            <FileDownIcon size={15} aria-hidden="true" /> Save text…
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
            {usesPaste ? "Paste into app" : "Insert"}
          </button>
        </div>
      </div>
    </div>
  );
}
