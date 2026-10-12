import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { useRef, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import type {
  ProviderUsageResetInput,
  ProviderUsageResetResult,
  ServerProvider,
} from "@cafecode/contracts";
import { hasLowCodexUsage } from "@cafecode/shared/providerUsageReset";
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import {
  formatCodexRateLimitPresentation,
  selectCodexAvailableResetCount,
} from "../lib/codexRateLimits";
import { ProviderAccountQuotaDetails } from "./ProviderAccountQuotaDetails";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";

export type RequestProviderUsageReset = (
  input: ProviderUsageResetInput,
) => Promise<ProviderUsageResetResult>;

const OUTCOME_TEXT = {
  get reset() {
    return uiText("Your usage limit reset was redeemed.");
  },
  get alreadyRedeemed() {
    return uiText("This reset was already redeemed. No additional reset was spent.");
  },
  get nothingToReset() {
    return uiText("There is no eligible usage window to reset. No reset was spent.");
  },
  get noCredit() {
    return uiText("No usage limit resets are available for this account.");
  },
} as const;

function resetFailureMessage(error: unknown, fallback: string): string {
  // This dedicated RPC error contains only Cafe-authored, sanitized messages.
  // Transport and native provider errors retain the fixed fallback instead.
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "ProviderUsageResetError" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return fallback;
}

export function ProviderUsageResetButton(props: {
  readonly provider: ServerProvider | null | undefined;
  readonly request: RequestProviderUsageReset;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProviderUsageResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Capture the provider AND transport at opening, so changing the selected
  // thread/environment cannot redirect a confirmation to another account.
  const target = useRef<{ provider: ServerProvider; request: RequestProviderUsageReset } | null>(
    null,
  );
  const inFlight = useRef(false);
  const generation = useRef(0);
  const provider = props.provider;
  // Fast reads show no indicator at all (docs/style-guide.md §9).
  const showBusy = useDelayedFlag(busy);
  const visible =
    provider?.enabled &&
    provider.driver === "codex" &&
    provider.auth.status === "authenticated" &&
    provider.auth.type === "chatgpt" &&
    (selectCodexAvailableResetCount(provider.accountRateLimits) ?? 0) > 0 &&
    hasLowCodexUsage(provider.accountRateLimits);

  const preview = async () => {
    if (inFlight.current || !target.current) return;
    const current = target.current;
    const requestGeneration = ++generation.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await current.request({
        action: "preview",
        instanceId: current.provider.instanceId,
      });
      if (requestGeneration === generation.current) setResult(response);
    } catch (error) {
      if (requestGeneration === generation.current) {
        setError(
          resetFailureMessage(
            error,
            uiText(
              "Could not check reset availability. Check your connection and Codex authentication, then try again.",
              undefined,
              undefined,
              uiLocale,
            ),
          ),
        );
      }
    } finally {
      if (requestGeneration === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  const redeem = async () => {
    if (inFlight.current || !target.current || !result?.confirmationId || result.outcome) return;
    const current = target.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await current.request({
          action: "redeem",
          instanceId: current.provider.instanceId,
          confirmationId: result.confirmationId,
        }),
      );
    } catch (error) {
      // The response may have been lost after the credit was spent. Retain the
      // server confirmation id; reopening also recovers this pending attempt.
      setResult({ ...result, retrying: true });
      setError(
        resetFailureMessage(
          error,
          uiText(
            "The reset result could not be confirmed. Retry this same reset safely; an already redeemed reset will not be spent again.",
            undefined,
            undefined,
            uiLocale,
          ),
        ),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const count = result?.rateLimits?.rateLimitResetCredits?.availableCount;
  const quota = uiPresentation.formatCodexRateLimitPresentation(result?.rateLimits);
  const finished = result?.outcome != null;
  const canRedeem = Boolean(result?.confirmationId && !finished);

  return (
    <>
      {visible ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0 gap-1 text-xs"
          onClick={() => {
            if (!provider || inFlight.current) return;
            target.current = { provider, request: props.request };
            setOpen(true);
            void preview();
          }}
        >
          <RotateCcwIcon className="size-3" />
          {uiText("Redeem reset", undefined, undefined, uiLocale)}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!inFlight.current) setOpen(next);
        }}
      >
        <DialogPopup className="max-w-md" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {finished
                ? uiText("Usage reset result", undefined, undefined, uiLocale)
                : uiText("Redeem a usage reset?", undefined, undefined, uiLocale)}
            </DialogTitle>
            <DialogDescription className="pr-5 [overflow-wrap:anywhere]">
              {target.current?.provider.displayName ??
                uiText("Codex", undefined, undefined, uiLocale)}
              {target.current?.provider.auth.email
                ? ` · ${target.current.provider.auth.email}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4 text-sm">
            {showBusy ? (
              <p role="status" className="flex items-center gap-2 text-muted-foreground">
                <Spinner aria-hidden="true" className="size-4" />
                {result?.confirmationId
                  ? uiText("Confirming reset…", undefined, undefined, uiLocale)
                  : uiText("Checking usage…", undefined, undefined, uiLocale)}
              </p>
            ) : null}
            {result?.outcome ? (
              <p role="status">{uiPresentation.OUTCOME_TEXT[result.outcome]}</p>
            ) : null}
            {/* Keep the last read visible while a confirmation is in flight so
                the dialog does not empty out and jump. */}
            {result ? (
              <>
                <div className="space-y-1 rounded-xl border border-border-subtle bg-muted/30 p-3">
                  {quota ? (
                    <ProviderAccountQuotaDetails
                      presentation={{ ...quota, resetAvailability: null }}
                    />
                  ) : null}
                  <p className="font-medium tabular-nums">
                    {count === undefined
                      ? uiText("Reset count not reported", undefined, undefined, uiLocale)
                      : uiText(
                          "{count} usage limit {count, plural, one {reset} other {resets}} available",
                          { count },
                          undefined,
                          uiLocale,
                        )}
                  </p>
                </div>
                {!finished && !result.retrying && canRedeem ? (
                  <p>
                    {uiText(
                      "This spends one of your earned resets on eligible Codex limits and can''t be undone.",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  </p>
                ) : null}
                {!busy && !finished && !result.retrying && !canRedeem ? (
                  <p>
                    {count === 0
                      ? uiText(
                          "You have no earned resets available. Your limits reset on schedule.",
                          undefined,
                          undefined,
                          uiLocale,
                        )
                      : count === undefined
                        ? uiText(
                            "Codex didn''t report reset availability. Try refreshing or updating Codex.",
                            undefined,
                            undefined,
                            uiLocale,
                          )
                        : uiText(
                            "Usage is above 5% remaining, so no reset is needed.",
                            undefined,
                            undefined,
                            uiLocale,
                          )}
                  </p>
                ) : null}
                {!busy && result.retrying && !error ? (
                  <p>
                    {uiText(
                      "An earlier reset''s result is unconfirmed. Retry the same reset to check it safely.",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  </p>
                ) : null}
                {finished && !result.rateLimits ? (
                  <p>
                    {uiText(
                      "Confirmed, but updated usage isn''t available yet. Refresh usage to check.",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  </p>
                ) : null}
              </>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {finished
                ? uiText("Done", undefined, undefined, uiLocale)
                : uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            {error && canRedeem ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void preview()}
              >
                {uiText("Check availability", undefined, undefined, uiLocale)}
              </Button>
            ) : null}
            {canRedeem ? (
              <Button type="button" disabled={busy} onClick={() => void redeem()}>
                {result?.retrying
                  ? uiText("Retry same reset", undefined, undefined, uiLocale)
                  : uiText("Redeem 1 reset", undefined, undefined, uiLocale)}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void preview()}
              >
                {finished
                  ? uiText("Refresh usage", undefined, undefined, uiLocale)
                  : uiText("Check again", undefined, undefined, uiLocale)}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { OUTCOME_TEXT, formatCodexRateLimitPresentation };
