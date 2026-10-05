import type { ContextMenuItem } from "@cafecode/contracts";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { deskTabKey } from "../../deskModel";
import { useDeskStore } from "../../deskStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { readDeskTabMetadata } from "./useDeskTabMetadata";

// A row and its top tab can represent the same chat. Share only pending action
// identity, never provider state, so reopening the other menu cannot duplicate
// a confirmed destructive operation while its acknowledgement is pending.
const pendingActions = new Set<string>();

function items(target: ThreadRouteTarget): ContextMenuItem[] {
  const metadata = readDeskTabMetadata(target);
  if (!metadata.threadRef || !metadata.exists) return [];
  const pending = pendingActions.has(
    JSON.stringify([metadata.threadRef.environmentId, metadata.threadRef.threadId]),
  );
  return [
    { id: "archive", label: "Archive chat", disabled: pending || metadata.working },
    { id: "delete", label: "Move to Recycle Bin", destructive: true, disabled: pending },
    { id: "delete-forever", label: "Delete permanently…", destructive: true, disabled: pending },
  ];
}

export function useDeskChatActions() {
  const { archiveThread, confirmAndDeleteThread, deleteThread, hardDeleteThread } =
    useThreadActions();
  const confirmArchive = useSettings((settings) => settings.confirmThreadArchive);

  const run = async (action: string, target: ThreadRouteTarget): Promise<boolean> => {
    if (action !== "archive" && action !== "delete" && action !== "delete-forever") return false;
    // Resolve the exact captured target again after the menu closes. A removed
    // shell or unpromoted draft cannot authorize a mutation of a selected peer.
    const metadata = readDeskTabMetadata(target);
    const ref = metadata.threadRef;
    const api = readLocalApi();
    if (!ref || !metadata.exists || !api) return true;
    const key = JSON.stringify([ref.environmentId, ref.threadId]);
    if (pendingActions.has(key)) return true;
    pendingActions.add(key);
    try {
      if (action === "archive") {
        if (metadata.working) return true;
        if (
          confirmArchive &&
          !(await api.dialogs.confirm(
            `Archive chat "${metadata.title}"?\nYou can restore it from Settings > Archived.`,
          ))
        )
          return true;
        // Confirmation can outlive a new turn or draft promotion. Never
        // archive a newly busy or differently scoped chat on stale consent.
        const current = readDeskTabMetadata(target);
        if (
          !current.exists ||
          current.working ||
          current.threadRef?.environmentId !== ref.environmentId ||
          current.threadRef.threadId !== ref.threadId
        )
          return true;
        await archiveThread(ref);
      } else if (action === "delete") {
        // Existing recycle-bin preferences, worktree consent, exact session
        // stop and navigation remain owned by the existing chat action.
        await confirmAndDeleteThread(ref);
        return true;
      } else {
        // Permanent deletion always asks, even if recycle-bin confirmation is
        // disabled. No stop, soft deletion or filesystem work precedes consent.
        if (
          !(await api.dialogs.confirm(
            [
              `Delete chat "${metadata.title}" permanently?`,
              "This removes local chat history, activity, provider session mappings, attachments, and checkpoint metadata.",
              "This cannot be undone.",
            ].join("\n"),
          ))
        )
          return true;
        // Retain the established soft-delete navigation/stop/worktree boundary.
        // If final purge fails, recovery evidence remains in Recently Deleted;
        // do not silently retry an indeterminate destructive acknowledgement.
        await deleteThread(ref);
        await hardDeleteThread(ref, { confirm: false });
      }
      const desk = useDeskStore.getState().desk;
      if (desk.environmentId === ref.environmentId) {
        useDeskStore.getState().dispatch({ type: "close", tabKey: deskTabKey(target) });
      }
    } catch {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not finish the chat action",
          description:
            action === "delete-forever"
              ? "Check the connection and Recently Deleted before trying again. The action was not automatically repeated."
              : "Check the chat's connection and current activity before trying again.",
        }),
      );
    } finally {
      pendingActions.delete(key);
    }
    return true;
  };
  return { items, run };
}
