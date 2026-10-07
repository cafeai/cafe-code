import "../../index.css";
import { EnvironmentId } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const shell = vi.hoisted(() => ({
  openInEditor: vi.fn(async () => undefined),
  openTerminal: vi.fn(async () => undefined),
}));
vi.mock("../../environments/primary", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../../localApi", () => ({ readLocalApi: () => ({ shell }) }));
vi.mock("../../editorPreferences", () => ({ usePreferredEditor: () => ["vscode", vi.fn()] }));
vi.mock("../../keybindings", () => ({
  isOpenFavoriteEditorShortcut: (event: KeyboardEvent) => event.ctrlKey && event.key === "o",
  shortcutLabelForCommand: () => null,
}));
import { OpenInPicker } from "./OpenInPicker";

beforeEach(() => {
  shell.openInEditor.mockClear();
  shell.openTerminal.mockClear();
});
it("keeps the favorite-editor shortcut when its buttons move into the tab menu", async () => {
  const mounted = await render(
    <OpenInPicker
      environmentId={EnvironmentId.make("local")}
      keybindings={[]}
      availableEditors={["vscode"]}
      terminal={{ label: "Shell", available: true }}
      openInCwd="/fixture/project"
      shortcutOnly
    />,
  );
  try {
    expect(document.querySelector('[aria-label="Subscription actions"]')).toBeNull();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(shell.openInEditor).toHaveBeenCalledWith("/fixture/project", "vscode");
  } finally {
    await mounted.unmount();
  }
});
it("offers no remote file or terminal controls and cannot launch a local editor for a remote path", async () => {
  const mounted = await render(
    <OpenInPicker
      environmentId={EnvironmentId.make("remote")}
      keybindings={[]}
      availableEditors={["vscode"]}
      terminal={{ label: "Shell", available: true }}
      openInCwd="/remote/repo"
    />,
  );
  try {
    expect(document.querySelector("button")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true }));
    expect(shell.openInEditor).not.toHaveBeenCalled();
    expect(shell.openTerminal).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});
it("keeps the existing external editor action for a local project", async () => {
  const mounted = await render(
    <OpenInPicker
      environmentId={EnvironmentId.make("local")}
      keybindings={[]}
      availableEditors={["vscode"]}
      terminal={{ label: "Shell", available: true }}
      openInCwd="/local/repo"
    />,
  );
  try {
    await page.getByRole("button", { name: "Open", exact: true }).click();
    expect(shell.openInEditor).toHaveBeenCalledWith("/local/repo", "vscode");
  } finally {
    await mounted.unmount();
  }
});
