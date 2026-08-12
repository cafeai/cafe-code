import { memo, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  scopeKey,
}: {
  error: string | null;
  /** Stable environment/thread identity; error text supplies the occurrence key. */
  scopeKey: string;
}) {
  const [dismissedErrorsByScope, setDismissedErrorsByScope] = useState<
    Readonly<Record<string, string>>
  >({});

  // Session snapshots are authoritative and may repeat unchanged lastError
  // values. Dismissal is presentation state: retain the exact dismissed error
  // per thread instead of mutating the projected snapshot and having the next
  // poll immediately restore it. A different error for the same thread still
  // appears, and no error strings are written to browser persistence.
  if (!error || dismissedErrorsByScope[scopeKey] === error) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss error"
            className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
            onClick={() =>
              setDismissedErrorsByScope((current) =>
                current[scopeKey] === error ? current : { ...current, [scopeKey]: error },
              )
            }
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
