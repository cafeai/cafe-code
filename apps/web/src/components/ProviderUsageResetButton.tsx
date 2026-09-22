import { useRef, useState } from "react";
import { LoaderCircleIcon, RotateCcwIcon } from "lucide-react";
import type {
  ProviderUsageResetInput,
  ProviderUsageResetResult,
  ServerProvider,
} from "@cafecode/contracts";
import { hasLowCodexUsage } from "@cafecode/shared/providerUsageReset";
import { formatCodexRateLimitSummary } from "../lib/codexRateLimits";
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

export type RequestProviderUsageReset = (
  input: ProviderUsageResetInput,
) => Promise<ProviderUsageResetResult>;

const OUTCOME_TEXT = {
  reset: "Your usage limit reset was redeemed.",
  alreadyRedeemed: "This reset was already redeemed. No additional reset was spent.",
  nothingToReset: "There is no eligible usage window to reset. No reset was spent.",
  noCredit: "No usage limit resets are available for this account.",
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
  const visible =
    provider?.enabled &&
    provider.driver === "codex" &&
    provider.auth.status === "authenticated" &&
    provider.auth.type === "chatgpt" &&
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
            "Could not check reset availability. Check your connection and Codex authentication, then try again.",
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
          "The reset result could not be confirmed. Retry this same reset safely; an already redeemed reset will not be spent again.",
        ),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const count = result?.rateLimits?.rateLimitResetCredits?.availableCount;
  const summary = formatCodexRateLimitSummary(result?.rateLimits);
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
          Redeem reset
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
            <DialogTitle>{finished ? "Usage reset result" : "Redeem a usage reset?"}</DialogTitle>
            <DialogDescription className="pr-5 [overflow-wrap:anywhere]">
              {target.current?.provider.displayName ?? "Codex"}
              {target.current?.provider.auth.email
                ? ` · ${target.current.provider.auth.email}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4 text-sm">
            {busy ? (
              <p role="status" className="flex items-center gap-2 text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" />
                {result?.confirmationId
                  ? "Confirming reset…"
                  : "Checking current usage and resets…"}
              </p>
            ) : null}
            {result?.outcome ? <p role="status">{OUTCOME_TEXT[result.outcome]}</p> : null}
            {result && !busy ? (
              <>
                <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
                  <p className="font-medium">
                    {count === undefined
                      ? "Reset availability unavailable"
                      : `${count} usage limit ${count === 1 ? "reset" : "resets"} available`}
                  </p>
                  {summary?.primary ? (
                    <p className="text-muted-foreground">{summary.primary.text}</p>
                  ) : null}
                  {summary?.secondary ? (
                    <p className="text-muted-foreground">{summary.secondary.text}</p>
                  ) : null}
                  {summary?.primaryReset ? (
                    <p className="text-xs text-muted-foreground">{summary.primaryReset}</p>
                  ) : null}
                  {summary?.weeklyReset ? (
                    <p className="text-xs text-muted-foreground">{summary.weeklyReset}</p>
                  ) : null}
                </div>
                {!finished && !result.retrying && canRedeem ? (
                  <p>
                    This spends one of your earned resets to reset eligible Codex usage limits. It
                    cannot be undone.
                  </p>
                ) : null}
                {!finished && !result.retrying && !canRedeem ? (
                  <p>
                    {count === 0
                      ? "You have no earned resets available. You can wait for the scheduled usage reset."
                      : count === undefined
                        ? "Codex did not report reset availability. Try refreshing or updating Codex."
                        : "Your usage is no longer below 5% remaining. No reset is needed here."}
                  </p>
                ) : null}
                {result.retrying && !error ? (
                  <p>
                    An earlier reset has an unconfirmed result. Retry that same attempt to check it
                    safely.
                  </p>
                ) : null}
                {finished && !result.rateLimits ? (
                  <p>
                    The result is confirmed, but fresh usage is unavailable. Refresh usage to check
                    the updated limits.
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
              {finished ? "Done" : "Cancel"}
            </Button>
            {error && canRedeem ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void preview()}
              >
                Check availability
              </Button>
            ) : null}
            {canRedeem ? (
              <Button type="button" disabled={busy} onClick={() => void redeem()}>
                {result?.retrying ? "Retry same reset" : "Redeem 1 reset"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void preview()}
              >
                {finished ? "Refresh usage" : "Check again"}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
