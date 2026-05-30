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
  const [dismissedStatusKey, setDismissedStatusKey] = useState<string | null>(null);

  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const statusDismissKey = [
    status.instanceId,
    status.status,
    status.checkedAt ?? "",
    status.message ?? "",
  ].join("\u0000");
  const isDismissed = dismissedStatusKey === statusDismissKey;
  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const message = status.message ?? defaultMessage;

  if (isDismissed) {
    return null;
  }

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={message}>
          {message}
        </AlertDescription>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss provider status"
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
