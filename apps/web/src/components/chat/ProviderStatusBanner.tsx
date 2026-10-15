import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { type ServerProvider } from "@cafecode/contracts";
import { memo, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const uiLocale = useUiLocale();

  const [dismissedStatusKey, setDismissedStatusKey] = useState<string | null>(null);

  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  // Health checks can refresh checkedAt while reporting the same actionable
  // state. Keep a dismissal stable across those polls so a transient provider
  // probe timeout does not keep reappearing over the active chat.
  const statusDismissKey = [status.instanceId, status.status, status.message ?? ""].join("\u0000");
  const isDismissed = dismissedStatusKey === statusDismissKey;
  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  // The title already states the condition, so the body carries only the
  // provider's own explanation when it supplied one.
  const title =
    status.status === "error"
      ? uiText("{provider} unavailable", { provider: providerLabel }, undefined, uiLocale)
      : uiText("{provider} limited", { provider: providerLabel }, undefined, uiLocale);
  const message = status.message?.trim() || null;

  if (isDismissed) {
    return null;
  }

  return (
    <div
      data-provider-status-banner="true"
      className="w-full shrink-0 px-3 pt-3 mx-auto max-w-3xl animate-enter-rise"
    >
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        {message ? (
          <AlertDescription className="line-clamp-3" title={message}>
            {message}
          </AlertDescription>
        ) : null}
        <AlertAction>
          <button
            type="button"
            aria-label={uiText("Dismiss provider status", undefined, undefined, uiLocale)}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setDismissedStatusKey(statusDismissKey)}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
