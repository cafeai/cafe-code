import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import {
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type TerminalAvailability,
} from "@cafecode/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { ChevronDownIcon, TerminalIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { resolveEditorOpenOptions } from "../../editorOpenOptions";
import { readLocalApi } from "~/localApi";
import { toastManager } from "../ui/toast";
import { useChatPane } from "../../chatPaneContext";

import { usePrimaryEnvironmentId } from "../../environments/primary";

function openFailureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function openProjectInEditor(cwd: string, editor: EditorId) {
  void readLocalApi()
    ?.shell.openInEditor(cwd, editor)
    .catch((error: unknown) => {
      toastManager.add({
        title: uiText("Unable to open project"),
        description: openFailureMessage(error, uiText("The project was not opened.")),
        type: "error",
      });
    });
}

export function openProjectInTerminal(cwd: string, terminal: TerminalAvailability) {
  if (!terminal.available) return;
  void readLocalApi()
    ?.shell.openTerminal(cwd)
    .catch((error: unknown) => {
      toastManager.add({
        title: uiText("Unable to open {value0}", { value0: terminal.label }),
        description: openFailureMessage(error, uiText("The terminal was not opened.")),
        type: "error",
      });
    });
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  terminal,
  openInCwd,
  shortcutOnly = false,
}: {
  environmentId?: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminal: TerminalAvailability;
  openInCwd: string | null;
  shortcutOnly?: boolean;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const pane = useChatPane();
  const primary = usePrimaryEnvironmentId();
  const remote = Boolean(environmentId && environmentId !== primary);
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => uiPresentation.resolveEditorOpenOptions(navigator.platform, availableEditors),
    [availableEditors, uiPresentation],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const terminalMenuLabel = uiText(
    "Open {value0} Here",
    { value0: terminal.label },
    undefined,
    uiLocale,
  );

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readLocalApi();
      if (remote || !api || !openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      openProjectInEditor(openInCwd, editor);
      setPreferredEditor(editor);
    },
    [remote, preferredEditor, openInCwd, setPreferredEditor],
  );

  const openTerminal = useCallback(() => {
    const api = readLocalApi();
    if (remote || !api || !openInCwd || !terminal.available) return;
    openProjectInTerminal(openInCwd, terminal);
  }, [remote, openInCwd, terminal]);

  const openFavoriteEditorShortcutLabel = useMemo(
    () => uiPresentation.shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings, uiPresentation],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (remote || !pane.active || !pane.visible || e.defaultPrevented) return;
      const api = readLocalApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      openProjectInEditor(openInCwd, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [remote, preferredEditor, keybindings, openInCwd, pane.active, pane.visible]);

  if (remote || shortcutOnly) return null;
  return (
    <Group aria-label={uiText("Subscription actions", undefined, undefined, uiLocale)}>
      <Button
        size="xs"
        variant="outline"
        disabled={!preferredEditor || !openInCwd}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          {uiText("Open", undefined, undefined, uiLocale)}
        </span>
      </Button>
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={uiText("Copy options", undefined, undefined, uiLocale)}
              size="icon-xs"
              variant="outline"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && (
            <MenuItem disabled>
              {uiText("No installed editors found", undefined, undefined, uiLocale)}
            </MenuItem>
          )}
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            disabled={!openInCwd || !terminal.available}
            onClick={openTerminal}
            title={
              !openInCwd
                ? uiText("No workspace directory is available.", undefined, undefined, uiLocale)
                : !terminal.available
                  ? terminal.unavailableReason
                  : undefined
            }
          >
            <TerminalIcon aria-hidden="true" className="text-muted-foreground" />
            {terminalMenuLabel}
            {!terminal.available && terminal.unavailableReason && (
              <MenuShortcut className="normal-case tracking-normal">
                {terminal.unavailableReason}
              </MenuShortcut>
            )}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
});

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { resolveEditorOpenOptions, shortcutLabelForCommand };
