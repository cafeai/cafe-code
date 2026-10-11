import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import type { ContextMenuItem } from "@cafecode/contracts";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { usePreferredEditor } from "../../editorPreferences";
import { resolveEditorOpenOptions } from "../../editorOpenOptions";
import { getLocalShellCapabilities } from "../../localCapabilities";
import { useServerAvailableEditors, useServerTerminal } from "../../rpc/serverState";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { openProjectInEditor, openProjectInTerminal } from "../chat/OpenInPicker";
import { readDeskTabOpenContext } from "./useDeskTabMetadata";

export function useDeskOpenActions() {
  const uiLocale = useUiLocale();

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const availableEditors = useServerAvailableEditors();
  const terminal = useServerTerminal();
  const [, setPreferredEditor] = usePreferredEditor(availableEditors);
  return (target: ThreadRouteTarget) => {
    const context = readDeskTabOpenContext(target);
    const capabilities = getLocalShellCapabilities(context.environmentId);
    const options = resolveEditorOpenOptions(navigator.platform, availableEditors);
    const canOpen = Boolean(
      context.cwd &&
      primaryEnvironmentId &&
      context.environmentId === primaryEnvironmentId &&
      capabilities.canOpenLocalEditor,
    );
    const items: ContextMenuItem[] = canOpen
      ? [
          {
            id: "open-project",
            label: uiText("Open", undefined, undefined, uiLocale),
            children: [
              ...options.map(({ value, label }) => ({ id: `open-editor:${value}`, label })),
              ...(options.length
                ? []
                : [
                    {
                      id: "open-editor-unavailable",
                      label: uiText("No installed editors found", undefined, undefined, uiLocale),
                      disabled: true,
                    },
                  ]),
              {
                id: "open-terminal",
                label: uiText("Open {label} here", { label: terminal.label }, undefined, uiLocale),
                disabled: !terminal.available || !capabilities.canOpenLocalTerminal,
              },
            ],
          },
        ]
      : [];
    const run = (id: string) => {
      if (!id.startsWith("open-editor:") && id !== "open-terminal") return false;
      const current = readDeskTabOpenContext(target);
      if (
        !canOpen ||
        !context.cwd ||
        current.cwd !== context.cwd ||
        current.environmentId !== context.environmentId
      )
        return true;
      const currentCapabilities = getLocalShellCapabilities(current.environmentId);
      if (id === "open-terminal") {
        if (currentCapabilities.canOpenLocalTerminal) openProjectInTerminal(context.cwd, terminal);
      } else {
        const editor = options.find(({ value }) => id === `open-editor:${value}`)?.value;
        if (editor && currentCapabilities.canOpenLocalEditor) {
          openProjectInEditor(context.cwd, editor);
          setPreferredEditor(editor);
        }
      }
      return true;
    };
    return { items, run };
  };
}

// Finite source-owned labels/helpers only; no received or user data.
