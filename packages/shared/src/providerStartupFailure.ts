import { uiText, type UiLocale } from "./i18n.ts";

/** Public presentation categories only. These values never authorize a retry,
 * infer native exit, change permissions or replace a provider session. Keep
 * this closed set separate from opaque provider-authored error details. */
export type ProviderStartupFailureCategory = "glide-attach" | "glide-activate" | "glide-capacity";

export function readProviderStartupFailureCategory(
  value: unknown,
): ProviderStartupFailureCategory | undefined {
  switch (value) {
    case "glide-attach":
    case "glide-activate":
    case "glide-capacity":
      return value;
    default:
      return undefined;
  }
}

/** Only Cafe-authored literals enter the translator. Server sanitization uses
 * the explicit English default; renderer presentation selects its own locale.
 * Do not accept a received detail string as translation source or argument. */
export function providerStartupFailureDetail(
  category: ProviderStartupFailureCategory,
  locale: UiLocale = "en",
): string {
  switch (category) {
    case "glide-attach":
      return uiText(
        "Glide desktop tools could not be attached. Check Computer use in the chat controls.",
        undefined,
        undefined,
        locale,
      );
    case "glide-activate":
      return uiText(
        "Glide desktop tools could not be activated. Check Computer use in the chat controls.",
        undefined,
        undefined,
        locale,
      );
    case "glide-capacity":
      return uiText(
        "Computer use connections are full. Stop an unused provider session, then try again.",
        undefined,
        undefined,
        locale,
      );
  }
}

/** This finite display marker is minted only after the server has replaced a
 * known local startup error with its exact safe detail. Matching arbitrary raw
 * causes, provider prose or a received category cannot grant this provenance. */
export function providerStartupFailureCategoryFromDetail(
  detail: string,
): ProviderStartupFailureCategory | undefined {
  for (const category of ["glide-attach", "glide-activate", "glide-capacity"] as const) {
    if (detail === providerStartupFailureDetail(category)) return category;
  }
  return undefined;
}

/** Saved activity payloads are data, but tolerate malformed/local callers
 * without consulting inherited fields or invoking a category accessor. The
 * original message/intent ownership checks remain the caller's separate gate. */
export function readProviderStartupFailureCategoryFromPayload(
  payload: unknown,
): ProviderStartupFailureCategory | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(payload, "startupFailureCategory");
    return field !== undefined && "value" in field
      ? readProviderStartupFailureCategory(field.value)
      : undefined;
  } catch {
    return undefined;
  }
}
