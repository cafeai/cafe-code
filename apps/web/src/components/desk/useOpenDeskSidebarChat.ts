import { uiText } from "@cafecode/shared/i18n";
import { useCallback } from "react";
import { getClientSettings } from "~/hooks/useSettings";
import { useUiLocale } from "~/i18n";

import { deskTabKey } from "../../deskModel";
import { useDeskStore } from "../../deskStore";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useOpenDeskSidebarChat(onNavigate: (target: ThreadRouteTarget) => void) {
  const uiLocale = useUiLocale();
  return useCallback(
    (target: ThreadRouteTarget, preview = true, groupId?: string) => {
      useDeskStore.getState().dispatch({
        type: "open",
        target,
        preview: preview && getClientSettings().chatClickBehavior === "preview",
        ...(groupId !== undefined ? { groupId } : {}),
      });
      const desk = useDeskStore.getState().desk;
      if (desk.groups[desk.activeGroupId]?.activeTabKey !== deskTabKey(target)) {
        // The reducer owns pane selection and admission. A refused open must
        // not move focus or let a sidebar route write bypass that decision.
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: uiText("Could not open chat", undefined, undefined, uiLocale),
            description: uiText("Close an open tab and try again.", undefined, undefined, uiLocale),
          }),
        );
        return;
      }
      onNavigate(target);
    },
    [onNavigate, uiLocale],
  );
}
