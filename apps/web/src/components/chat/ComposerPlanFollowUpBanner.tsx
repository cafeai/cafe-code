import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { memo } from "react";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  const uiLocale = useUiLocale();

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="label-overline">
          {uiText("Plan ready", undefined, undefined, uiLocale)}
        </span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {planTitle}
          </span>
        ) : null}
      </div>
    </div>
  );
});
