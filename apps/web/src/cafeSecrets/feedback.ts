import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import type { CafeSecretSendIssue } from "./cafeSecretsClient";

/** Finite presentation categories only; never a received error or value. */
export function cafeSecretIssueMessage(issue: CafeSecretSendIssue, locale: UiLocale): string {
  if (issue === "unsupported")
    return uiText(
      "Cafe Secrets are not supported by the current provider. If this is literal text, escape it with a backslash: \\[sec:VALUE].",
      undefined,
      undefined,
      locale,
    );
  if (issue === "incomplete")
    return uiText(
      "Finish the Cafe Secret with a closing ] or escape literal text with a backslash: \\[sec:VALUE].",
      undefined,
      undefined,
      locale,
    );
  return uiText(
    "A Cafe Secret in this message could not be prepared or is no longer available in this chat, so the message was not sent. If this is literal text, escape it with a backslash.",
    undefined,
    undefined,
    locale,
  );
}
