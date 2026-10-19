import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { useWorkspaceEnvironmentId } from "../../environments/workspace";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { selectBootstrapCompleteForEnvironment, useStore } from "../../store";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SidebarNewChatButton } from "./SidebarNewChatButton";

/** The hidden-sidebar entrypoint is navigation, never a provider submission. */
export function ContentSidebarNewChatButton() {
  const uiLocale = useUiLocale();
  const environmentId = useWorkspaceEnvironmentId();
  const bootstrapped = useStore((state) =>
    selectBootstrapCompleteForEnvironment(state, environmentId),
  );
  const { handleNewStandaloneChat } = useNewThreadHandler();

  const createChat = () => {
    // The shared handler captures the selected server and active Desk group
    // synchronously, rechecks capability, and reuses only an eligible draft.
    // In particular, a project chat in this header cannot supply project state.
    void handleNewStandaloneChat()
      .then(() => useThreadSelectionStore.getState().clearSelection())
      .catch(() => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not create chat", undefined, undefined, uiLocale),
            description: uiText(
              "Reconnect to Cafe Code and try again.",
              undefined,
              undefined,
              uiLocale,
            ),
          }),
        );
      });
  };

  return (
    <SidebarNewChatButton
      label={uiText("New chat", undefined, undefined, uiLocale)}
      disabled={!bootstrapped}
      onClick={createChat}
    />
  );
}
