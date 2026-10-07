import type { ScopedThreadRef } from "@cafecode/contracts";

import { readEnvironmentApi } from "./environmentApi";
import { newCommandId } from "./lib/utils";

/** Rename metadata through the same environment-scoped command as the project list.
 * A tab title is never an independent copy: the canonical thread event updates
 * every view, including panes, project rows and other connected clients.
 */
export async function renameThread(
  target: ScopedThreadRef,
  title: string,
  originalTitle: string,
): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Chat title can't be empty.");
  if (trimmed === originalTitle) return;
  const api = readEnvironmentApi(target.environmentId);
  if (!api) throw new Error("Reconnect to this chat’s server to rename it.");
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId: target.threadId,
    title: trimmed,
  });
}
