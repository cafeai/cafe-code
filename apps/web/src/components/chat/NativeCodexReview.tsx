import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { CodexReviewTarget, type RuntimeMode } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const isReviewTarget = Schema.is(CodexReviewTarget);

const REVIEW_TARGET_OPTIONS: ReadonlyArray<{
  readonly value: CodexReviewTarget["type"];
  readonly label: string;
}> = [
  {
    value: "uncommittedChanges",
    get label() {
      return uiText("Uncommitted changes");
    },
  },
  {
    value: "baseBranch",
    get label() {
      return uiText("Changes against a base branch");
    },
  },
  {
    value: "commit",
    get label() {
      return uiText("A specific commit");
    },
  },
  {
    value: "custom",
    get label() {
      return uiText("Custom instructions");
    },
  },
];

/** Same access names as the composer's Access menu (CompactComposerControlsMenu). */
const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  get "approval-required"() {
    return uiText("Supervised");
  },
  get "auto-accept-edits"() {
    return uiText("Auto-accept edits");
  },
  get "full-access"() {
    return uiText("Full access");
  },
};

function isReviewTargetType(value: unknown): value is CodexReviewTarget["type"] {
  return REVIEW_TARGET_OPTIONS.some((option) => option.value === value);
}

export interface NativeCodexReviewProps {
  /** Parent keys this component by exact environment/chat/account identity. */
  readonly accountLabel: string;
  readonly runtimeMode: RuntimeMode;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStart: (target: CodexReviewTarget) => Promise<void>;
}

/** A deliberate native operation, not `/review` text parsing. The existing
 * owner-authorized durable dispatch owns submission; this form never retries. */
export function NativeCodexReview({
  accountLabel,
  runtimeMode,
  disabled,
  open,
  onOpenChange,
  onStart,
}: NativeCodexReviewProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [kind, setKind] = useState<CodexReviewTarget["type"]>("uncommittedChanges");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      // The user can return to the exact same account/key before an old ACK
      // settles. That old dialog must never close or update its replacement.
      // Layout cleanup retires this instance before another user event or
      // promise continuation can reach the newly mounted controlled dialog.
      mountedRef.current = false;
    };
  }, []);
  const target =
    kind === "uncommittedChanges"
      ? { type: kind }
      : kind === "baseBranch"
        ? { type: kind, branch: value }
        : kind === "commit"
          ? { type: kind, sha: value }
          : { type: kind, instructions: value };
  const valid = isReviewTarget(target);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pendingRef.current) {
          setError(null);
          onOpenChange(next);
        }
      }}
    >
      <DialogPopup className="no-drag max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {uiText("Start a Codex review", undefined, undefined, uiLocale)}
          </DialogTitle>
          <DialogDescription>
            {uiText(
              "Codex reviews code for bugs and risks; findings appear in this chat.",
              undefined,
              undefined,
              uiLocale,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              // This dialog is portalled from inside the composer form.
              // React submit events still bubble through that parent: a review
              // must never also submit the ordinary unsent composer prompt.
              event.stopPropagation();
              if (disabled || pendingRef.current || !isReviewTarget(target)) return;
              pendingRef.current = true;
              setPending(true);
              setError(null);
              try {
                await onStart(target);
                if (mountedRef.current) onOpenChange(false);
              } catch {
                if (mountedRef.current) {
                  setError(
                    uiText(
                      "The review could not be confirmed. Check the chat’s work log and provider connection before trying again; it was not automatically resent.",
                      undefined,
                      undefined,
                      uiLocale,
                    ),
                  );
                }
              } finally {
                pendingRef.current = false;
                if (mountedRef.current) setPending(false);
              }
            }}
          >
            <div className="space-y-1.5 text-sm">
              <span aria-hidden="true">
                {uiText("Review target", undefined, undefined, uiLocale)}
              </span>
              <Select
                value={kind}
                disabled={pending}
                onValueChange={(next) => {
                  if (!isReviewTargetType(next)) return;
                  setKind(next);
                  setValue("");
                  setError(null);
                }}
              >
                <SelectTrigger aria-label={uiText("Review target", undefined, undefined, uiLocale)}>
                  <SelectValue>
                    {
                      uiPresentation.REVIEW_TARGET_OPTIONS.find((option) => option.value === kind)
                        ?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {uiPresentation.REVIEW_TARGET_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {kind !== "uncommittedChanges" && (
              <label className="block space-y-1 text-sm">
                <span>
                  {kind === "baseBranch"
                    ? uiText("Base branch", undefined, undefined, uiLocale)
                    : kind === "commit"
                      ? uiText("Commit SHA", undefined, undefined, uiLocale)
                      : uiText("Review instructions", undefined, undefined, uiLocale)}
                </span>
                {kind === "custom" ? (
                  <textarea
                    className="focus-ring min-h-28 w-full rounded-lg border border-input bg-background px-3 py-2"
                    value={value}
                    maxLength={16_000}
                    disabled={pending}
                    onChange={(event) => setValue(event.target.value)}
                  />
                ) : (
                  <input
                    className="focus-ring w-full rounded-lg border border-input bg-background px-3 py-2"
                    value={value}
                    maxLength={kind === "commit" ? 64 : 512}
                    disabled={pending}
                    placeholder={
                      kind === "commit"
                        ? uiText("7–64 hexadecimal characters", undefined, undefined, uiLocale)
                        : uiText("main", undefined, undefined, uiLocale)
                    }
                    onChange={(event) => setValue(event.target.value)}
                  />
                )}
              </label>
            )}
            {/* Required disclosure (AGENTS.md): the saved session's account and
                permission mode, before submission. Unsent composer overrides never
                apply to a native review. */}
            <p
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              data-native-review-disclosure="true"
            >
              <span className="min-w-0">
                <UiMessage
                  message={"<slot1></slot1> · <slot3></slot3> · runs without approval prompts"}
                  slots={{
                    slot1: accountLabel,
                    slot3: uiPresentation.RUNTIME_MODE_LABELS[runtimeMode],
                  }}
                />
              </span>
              <InfoTip label={uiText("About Codex reviews", undefined, undefined, uiLocale)}>
                {uiText(
                  "Uses this chat’s current Codex session and its review-model settings, not unsent composer changes. The reviewer runs under the session’s sandbox",
                  undefined,
                  undefined,
                  uiLocale,
                )}
                {runtimeMode === "full-access"
                  ? uiText(", which has full access", undefined, undefined, uiLocale)
                  : uiText(", unexpanded", undefined, undefined, uiLocale)}
                {uiText(
                  ". Stop chat cancels the review. For a separate review, open a separate chat first.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </InfoTip>
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            )}
            {disabled && (
              <p role="status" className="text-sm text-muted-foreground">
                {uiText(
                  "Wait for current work to finish and reconnect first.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  onOpenChange(false);
                }}
              >
                {uiText("Cancel", undefined, undefined, uiLocale)}
              </Button>
              <Button type="submit" disabled={disabled || pending || !valid}>
                {pending
                  ? uiText("Starting review…", undefined, undefined, uiLocale)
                  : uiText("Start review", undefined, undefined, uiLocale)}
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { REVIEW_TARGET_OPTIONS, RUNTIME_MODE_LABELS };
