import { CodexReviewTarget, type RuntimeMode } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const isReviewTarget = Schema.is(CodexReviewTarget);

export interface NativeCodexReviewProps {
  /** Parent keys this component by exact environment/chat/account identity. */
  readonly accountLabel: string;
  readonly runtimeMode: RuntimeMode;
  readonly disabled: boolean;
  readonly onStart: (target: CodexReviewTarget) => Promise<void>;
}

/** A deliberate native operation, not `/review` text parsing. The existing
 * owner-authorized durable dispatch owns submission; this form never retries. */
export function NativeCodexReview({
  accountLabel,
  runtimeMode,
  disabled,
  onStart,
}: NativeCodexReviewProps) {
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
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Native review
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pendingRef.current) setOpen(next);
        }}
      >
        <DialogPopup className="no-drag max-w-lg">
          <DialogHeader>
            <DialogTitle>Start a native Codex review</DialogTitle>
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
