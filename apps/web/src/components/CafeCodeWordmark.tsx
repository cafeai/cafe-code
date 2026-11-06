import { DEFAULT_BRAND_WORDMARK_PREFIX } from "@cafecode/contracts/settings";
import { uiText } from "@cafecode/shared/i18n";

import { useUiLocale } from "~/i18n";
import { useSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

export const SIDEBAR_STAGE_BADGE_CLASS_NAME =
  "rounded-full bg-muted px-1.5 py-0.5 text-2xs leading-none font-medium text-subtle-foreground";

/**
 * The sidebar wordmark: the branding prefix in bold, then "Code". Pass
 * `prefix` to preview an unsaved value (Settings → Branding prefix).
 */
export function CafeCodeWordmark({ className, prefix }: { className?: string; prefix?: string }) {
  const uiLocale = useUiLocale();
  const savedPrefix = useSettings(
    (s) => s.brandWordmarkPrefix?.trim() || DEFAULT_BRAND_WORDMARK_PREFIX,
  );
  const shownPrefix =
    prefix === undefined ? savedPrefix : prefix.trim() || DEFAULT_BRAND_WORDMARK_PREFIX;
  return (
    <span
      aria-label={uiText("{value0} Code", { value0: shownPrefix }, undefined, uiLocale)}
      className={cn("shrink-0 text-sm text-foreground", className)}
    >
      <span className="font-bold">{shownPrefix}</span>
      <span className="font-medium text-muted-foreground">
        {uiText(" Code", undefined, undefined, uiLocale)}
      </span>
    </span>
  );
}
