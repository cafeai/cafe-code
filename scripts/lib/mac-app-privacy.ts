import { uiText, type UiLocale } from "@cafecode/shared/i18n";

// Keep source launches and packaged apps on the same user-facing explanation.
// This declares the purpose of LAN access; macOS still owns the user's grant.
export function macLocalNetworkUsageDescription(locale: UiLocale = "en"): string {
  return uiText(
    "Cafe Code connects to Cafe servers you select on your local network.",
    undefined,
    undefined,
    locale,
  );
}
export const MAC_LOCAL_NETWORK_USAGE_DESCRIPTION = macLocalNetworkUsageDescription();

export function macMicrophoneUsageDescription(locale: UiLocale = "en"): string {
  return uiText(
    "Cafe Code uses microphone audio only when you start dictation.",
    undefined,
    undefined,
    locale,
  );
}
export const MAC_MICROPHONE_USAGE_DESCRIPTION = macMicrophoneUsageDescription();

/** Bundled copy only. Quoting prevents translated punctuation from becoming
 * another native property assignment. No text becomes script or OS authority. */
export function renderMacPrivacyStrings(locale: UiLocale): string {
  const quote = (text: string) =>
    `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
  return `"NSMicrophoneUsageDescription" = ${quote(macMicrophoneUsageDescription(locale))};\n"NSLocalNetworkUsageDescription" = ${quote(macLocalNetworkUsageDescription(locale))};\n`;
}
