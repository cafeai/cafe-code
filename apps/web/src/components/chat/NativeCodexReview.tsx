import { CodexReviewTarget, type RuntimeMode } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronUpIcon, FileSearchIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const isReviewTarget = Schema.is(CodexReviewTarget);

export interface NativeCodexReviewProps {
  /** Parent keys this component by exact environment/chat/account identity. */
  readonly accountLabel: string;
  readonly runtimeMode: RuntimeMode;
  readonly disabled: boolean;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onStart: (target: CodexReviewTarget) => Promise<void>;
}

/** A deliberate native operation, not `/review` text parsing. The existing
 * owner-authorized durable dispatch owns submission; this form never retries. */
export function NativeCodexReview({
  accountLabel,
  runtimeMode,
  disabled,
  collapsed,
  onCollapsedChange,
  onStart,
}: NativeCodexReviewProps) {
  const tooltipId = useId();
  const contentId = useId();
  const toggleTooltipId = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CodexReviewTarget["type"]>("uncommittedChanges");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
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
    <>
      {/* Starting a review can make the chat busy before its acknowledgement
          arrives. Hide only the trigger; keep its dialog and pending/error
          state mounted until that submission settles. */}
      {!disabled && (
        <div className="no-drag cafe-code-review-tab-entry inline-flex max-w-full">
          <div
            className="cafe-code-review-tab"
            data-collapsed={collapsed ? "true" : "false"}
            data-review-open={open ? "true" : "false"}
          >
            <svg
              aria-hidden="true"
              className="cafe-code-review-tab-shape"
              viewBox="0 0 180 32"
              preserveAspectRatio="none"
            >
              <path
                className="cafe-code-review-tab-fill"
                d="M0 32C9 32 14 31 16 20L18 11C19 5 23 1 30 1H150C157 1 161 5 162 11L164 20C166 31 171 32 180 32Z"
              />
              <path
                className="cafe-code-review-tab-outline"
                d="M0 32C9 32 14 31 16 20L18 11C19 5 23 1 30 1H150C157 1 161 5 162 11L164 20C166 31 171 32 180 32"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <span id={contentId} className="cafe-code-review-tab-content" hidden={collapsed}>
              <Tooltip>
                <TooltipTrigger
                  delay={250}
                  render={<span className="inline-flex w-full min-w-0" />}
                >
                  <button
                    type="button"
                    className="cafe-code-review-tab-action"
                    disabled={disabled}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-describedby={tooltipId}
                    onClick={() => {
                      setError(null);
                      setOpen(true);
                    }}
                  >
                    <FileSearchIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate">Code review</span>
                  </button>
                </TooltipTrigger>
                <TooltipPopup
                  id={tooltipId}
                  role="tooltip"
                  side="top"
                  className="no-drag max-w-72 whitespace-normal leading-relaxed"
                >
                  Ask Codex to review code for bugs and risks. Choose uncommitted changes, a branch,
                  a commit, or custom instructions. Findings appear in this chat.
                </TooltipPopup>
              </Tooltip>
            </span>
            <Tooltip>
              <TooltipTrigger
                delay={250}
                render={
                  <button
                    type="button"
                    className="cafe-code-review-tab-toggle"
                    aria-label={collapsed ? "Expand code review" : "Minimize code review"}
                    aria-expanded={!collapsed}
                    aria-controls={contentId}
                    aria-describedby={toggleTooltipId}
                    onClick={() => onCollapsedChange(!collapsed)}
                  />
                }
              >
                {collapsed ? (
                  <ChevronUpIcon aria-hidden="true" className="size-3.5" />
                ) : (
                  <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipPopup id={toggleTooltipId} role="tooltip" className="no-drag">
                {collapsed ? "Expand code review" : "Minimize code review"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pendingRef.current) setOpen(next);
        }}
      >
        <DialogPopup className="no-drag max-w-lg">
          <DialogHeader>
            <DialogTitle>Start a code review</DialogTitle>
            <DialogDescription>
              Review in this chat with {accountLabel}. Uses the current native session and its
              review-model settings, not unsent composer changes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              className="space-y-4"
              onSubmit={async (event) => {
                event.preventDefault();
                // This dialog is portalled from a tab inside the composer form.
                // React submit events still bubble through that parent: a review
                // must never also submit the ordinary unsent composer prompt.
                event.stopPropagation();
                if (disabled || pendingRef.current || !isReviewTarget(target)) return;
                pendingRef.current = true;
                setPending(true);
                setError(null);
                try {
                  await onStart(target);
                  setOpen(false);
                } catch {
                  setError(
                    "The review could not be confirmed. Check the chat’s work log and provider connection before trying again; it was not automatically resent.",
                  );
                } finally {
                  pendingRef.current = false;
                  setPending(false);
                }
              }}
            >
              <label className="block space-y-1 text-sm">
                <span>Review target</span>
                <select
                  aria-label="Review target"
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                  value={kind}
                  disabled={pending}
                  onChange={(event) => {
                    setKind(event.target.value as CodexReviewTarget["type"]);
                    setValue("");
                    setError(null);
                  }}
                >
                  <option value="uncommittedChanges">Uncommitted changes</option>
                  <option value="baseBranch">Changes against a base branch</option>
                  <option value="commit">A specific commit</option>
                  <option value="custom">Custom review instructions</option>
                </select>
              </label>
              {kind !== "uncommittedChanges" && (
                <label className="block space-y-1 text-sm">
                  <span>
                    {kind === "baseBranch"
                      ? "Base branch"
                      : kind === "commit"
                        ? "Commit SHA"
                        : "Review instructions"}
                  </span>
                  {kind === "custom" ? (
                    <textarea
                      className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2"
                      value={value}
                      maxLength={16_000}
                      disabled={pending}
                      onChange={(event) => setValue(event.target.value)}
                    />
                  ) : (
                    <input
                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                      value={value}
                      maxLength={kind === "commit" ? 64 : 512}
                      disabled={pending}
                      placeholder={kind === "commit" ? "7–64 hexadecimal characters" : "main"}
                      onChange={(event) => setValue(event.target.value)}
                    />
                  )}
                </label>
              )}
              <p className="text-xs text-muted-foreground">
                Codex’s native reviewer runs non-interactively, without approval prompts, under this
                session’s sandbox.{" "}
                {runtimeMode === "full-access"
                  ? "This chat currently has full access."
                  : "Its sandbox is not expanded."}{" "}
                Stop chat cancels the review. For a separate review, open a separate Cafe chat
                first.
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {disabled && (
                <p role="status" className="text-sm text-muted-foreground">
                  Wait for the current work to finish and reconnect before starting a review.
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={disabled || pending || !valid}>
                  {pending ? "Starting review…" : "Start review"}
                </Button>
              </div>
            </form>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
