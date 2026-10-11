import { uiText, type UiLocale } from "@cafecode/shared/i18n";

export type QueuedFollowUpFeedbackInput =
  | { readonly code: "missing-attachments"; readonly count: number }
  | {
      readonly code:
        | "stopped-before-send"
        | "delivery-unknown"
        | "delivery-paused"
        | "claimed-after-reload"
        | "review-before-send";
    };

export interface QueuedFollowUpFeedbackState {
  /** Canonical English remains the queue's existing comparison/admission data. */
  readonly blockedReason: string;
  /** Volatile, opaque display provenance; the persistence projection omits it. */
  readonly blockedFeedback: object;
}

interface MintedFeedback {
  readonly input: QueuedFollowUpFeedbackInput;
  readonly originalReason: string;
}

// An identical received string or serialized/cloned token cannot authorize a
// translation. Only this module's exact in-memory token carries provenance;
// the canonical reason is independently matched before any display formatting.
const feedbackByToken = new WeakMap<object, MintedFeedback>();

function formatKnownFeedback(input: QueuedFollowUpFeedbackInput, locale: UiLocale): string {
  switch (input.code) {
    case "missing-attachments":
      return uiText(
        "{count} {count, plural, one {attachment} other {attachments}} could not be restored after reconnecting. Remove this retry and resend the missing {count, plural, one {attachment} other {attachments}}.",
        { count: input.count },
        undefined,
        locale,
      );
    case "stopped-before-send":
      return uiText(
        "Stopped before sending. Select this queued message to send it.",
        undefined,
        undefined,
        locale,
      );
    case "delivery-unknown":
      return uiText(
        "Delivery status is unknown. Inspect the timeline before removing this queued message.",
        undefined,
        undefined,
        locale,
      );
    case "delivery-paused":
      return uiText(
        "Delivery paused. Your message and attachments are preserved. You can retry delivery.",
        undefined,
        undefined,
        locale,
      );
    case "claimed-after-reload":
      return uiText(
        "Delivery status is unknown after reload. Inspect the timeline before removing this queued message.",
        undefined,
        undefined,
        locale,
      );
    case "review-before-send":
      return uiText("Review this queued follow-up before sending.", undefined, undefined, locale);
    default:
      // This is an internal programmer invariant, never a received provider
      // error or a queue state transition. Reject rather than mint unknown UI.
      throw new TypeError("Invalid queued feedback code.");
  }
}

export function createQueuedFollowUpFeedback(
  input: QueuedFollowUpFeedbackInput,
): QueuedFollowUpFeedbackState {
  if (
    input.code === "missing-attachments" &&
    (!Number.isSafeInteger(input.count) || input.count <= 0)
  ) {
    throw new RangeError("Queued feedback attachment count must be a positive safe integer.");
  }

  // Copy the finite descriptor: later mutation of a caller's object cannot
  // replace the source/code/count associated with an already blocked queue row.
  const snapshot: QueuedFollowUpFeedbackInput = Object.freeze(
    input.code === "missing-attachments"
      ? { code: input.code, count: input.count }
      : { code: input.code },
  );
  const blockedReason = formatKnownFeedback(snapshot, "en");
  const blockedFeedback: object = Object.freeze(Object.create(null) as object);
  feedbackByToken.set(
    blockedFeedback,
    Object.freeze({ input: snapshot, originalReason: blockedReason }),
  );
  return Object.freeze({ blockedReason, blockedFeedback });
}

/**
 * Render only an exact locally minted descriptor while preserving queue truth.
 * Raw/legacy text, replaced reasons and forged/rehydrated tokens stay opaque.
 * This helper cannot clear a block, claim delivery, replay input or write state.
 */
export function formatQueuedFollowUpFeedback(
  blockedReason: string | null,
  blockedFeedback: unknown,
  locale: UiLocale,
): string | null {
  if (blockedReason === null || typeof blockedFeedback !== "object" || blockedFeedback === null) {
    return blockedReason;
  }
  const minted = feedbackByToken.get(blockedFeedback);
  if (minted === undefined || minted.originalReason !== blockedReason) return blockedReason;
  return formatKnownFeedback(minted.input, locale);
}
