import { uiText } from "@cafecode/shared/i18n";
import { EDITORS, EditorId, LocalApi } from "@cafecode/contracts";
import {
  getLocalStorageItemWithLegacy,
  setLocalStorageItemWithLegacy,
  useLocalStorage,
} from "./hooks/useLocalStorage";
import { useMemo } from "react";
import { splitPathAndPosition } from "./path-links";

const LAST_EDITOR_KEY = "cafe-code:last-editor";
const LEGACY_LAST_EDITOR_KEY = "cafecode:last-editor";

// A system association can execute programs, installers, scripts, shortcuts,
// and app bundles. Use a conservative cross-platform set: the renderer cannot
// reliably infer the local host's associations from the backend's platform.
// This is a consent safeguard, not authoritative file-type classification.
// In particular, a symlink with an ordinary document name can alias runnable
// content; proving its current target requires host filesystem metadata.
const SYSTEM_ASSOCIATION_LAUNCH_EXTENSIONS = new Set([
  "exe",
  "com",
  "scr",
  "pif",
  "cpl",
  "msi",
  "msp",
  "appx",
  "appxbundle",
  "msix",
  "msixbundle",
  "app",
  "appimage",
  "run",
  "bin",
  "jar",
  "jnlp",
  "bat",
  "cmd",
  "ps1",
  "psm1",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "hta",
  "py",
  "pyw",
  "pl",
  "rb",
  "sh",
  "bash",
  "zsh",
  "fish",
  "command",
  "scpt",
  "scptd",
  "applescript",
  "workflow",
  "lnk",
  "url",
  "webloc",
  "desktop",
  "appref-ms",
  "application",
  "reg",
  "inf",
  "msc",
]);

function validateSystemAssociationPath(path: string): void {
  if (
    path.trim().length === 0 ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw new Error(
      uiText("The system default cannot open an empty path or a path containing controls."),
    );
  }

  const normalized = path.replaceAll("\\", "/");
  // Win32 device namespaces and alternate data streams do not identify an
  // ordinary file association. Reject them instead of presenting a misleading
  // filename or letting native path normalization reinterpret the destination.
  if (/^(?:\/\/[?.]\/|\/\?\?\/)/u.test(normalized)) {
    throw new Error(uiText("The system default cannot open a Windows device path."));
  }
  const isDrivePath = /^[A-Za-z]:/u.test(normalized);
  if (
    (isDrivePath && normalized.slice(2).includes(":")) ||
    (normalized.startsWith("//") && normalized.includes(":"))
  ) {
    throw new Error(uiText("The system default cannot open a Windows alternate-stream path."));
  }
}

function requiresSystemAssociationConsent(path: string): boolean {
  // Normalization is only for the consent decision. Native opens still receive
  // the exact requested path. Removing terminal separators/spaces/dots closes
  // common Windows spellings such as `program.exe. ` and app-bundle slash forms.
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/[ .]+$/u, "");
  const extensionIndex = basename.lastIndexOf(".");
  // Extensionless commands and hidden names without a separate extension
  // (such as `.bashrc`) are ambiguous without native metadata. Ask once, while
  // explicit document/source extensions, including `.cafe-code-settings.json`,
  // keep their existing direct-open behavior.
  if (extensionIndex <= 0) return true;
  return SYSTEM_ASSOCIATION_LAUNCH_EXTENSIONS.has(basename.slice(extensionIndex + 1).toLowerCase());
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId, [
    LEGACY_LAST_EDITOR_KEY,
  ]);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  let stored: EditorId | null = null;
  try {
    stored = getLocalStorageItemWithLegacy(LAST_EDITOR_KEY, [LEGACY_LAST_EDITOR_KEY], EditorId);
  } catch {
    // Remembered editor state is a convenience, never launch authority. A stale
    // schema value or denied browser storage must not prevent an available,
    // schema-defined editor from opening a file the user explicitly requested.
  }
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) {
    try {
      setLocalStorageItemWithLegacy(LAST_EDITOR_KEY, [LEGACY_LAST_EDITOR_KEY], editor, EditorId);
    } catch {
      // Storage can be read-only or over quota even after a successful read.
      // Keep the current user action usable; future opens can resolve again.
    }
  }
  return editor ?? null;
}

export async function openInPreferredEditor(
  api: LocalApi,
  targetPath: string,
): Promise<EditorId | null> {
  const { availableEditors, clientSettings } = await api.server.getConfig();
  if (clientSettings.defaultEditor === "system-default") {
    // Native associations accept filesystem paths, not editor line/column
    // syntax. Parsing from the end preserves Windows drive-letter colons.
    const path = splitPathAndPosition(targetPath).path;
    validateSystemAssociationPath(path);
    if (requiresSystemAssociationConsent(path)) {
      const confirmed = await api.dialogs.confirm(
        uiText(
          "The system default may run code or launch an application for this path:\n\n{path}\n\nOpen with the system default?",
          { path: path },
        ),
      );
      // Declining is a completed user decision. Never retry through an editor
      // or another association, and never treat cancellation as an open error.
      if (!confirmed) return null;
    }
    await api.shell.openPath(path);
    return "file-manager";
  }

  if (availableEditors.includes(clientSettings.defaultEditor)) {
    // Explicit settings take precedence over the last editor picked from an
    // action menu. Keep the complete target so editor adapters can navigate.
    await api.shell.openInEditor(targetPath, clientSettings.defaultEditor);
    return clientSettings.defaultEditor;
  }

  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) throw new Error(uiText("No available editors found."));
  await api.shell.openInEditor(targetPath, editor);
  return editor;
}
