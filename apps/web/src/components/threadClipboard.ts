import type { ThreadId } from "@cafecode/contracts";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { copyTextToClipboard } from "../lib/copyToClipboard";
import { stackedThreadToast, toastManager } from "./ui/toast";

export async function copyThreadIdToClipboard(threadId: ThreadId, locale: UiLocale): Promise<void> {
  try {
    await copyTextToClipboard(threadId);
  } catch {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: uiText("Could not copy chat ID", undefined, undefined, locale),
      }),
    );
  }
}
