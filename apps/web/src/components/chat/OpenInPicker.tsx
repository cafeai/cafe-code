import {
  EditorId,
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

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  terminal,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminal: TerminalAvailability;
  openInCwd: string | null;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveEditorOpenOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const terminalMenuLabel = `Open ${terminal.label} Here`;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readLocalApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor);
      setPreferredEditor(editor);
    },
    [preferredEditor, openInCwd, setPreferredEditor],
  );

  const openTerminal = useCallback(() => {
    const api = readLocalApi();
    if (!api || !openInCwd || !terminal.available) return;
    void api.shell.openTerminal(openInCwd);
  }, [openInCwd, terminal.available]);

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readLocalApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void api.shell.openInEditor(openInCwd, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferredEditor, keybindings, openInCwd]);

  return (
    <Group aria-label="Subscription actions">
      <Button
        size="xs"
        variant="outline"
        disabled={!preferredEditor || !openInCwd}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <Menu>
        <MenuTrigger render={<Button aria-label="Copy options" size="icon-xs" variant="outline" />}>
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
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
                ? "No workspace directory is available."
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
