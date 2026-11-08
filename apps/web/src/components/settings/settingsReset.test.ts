import { DEFAULT_UNIFIED_SETTINGS } from "@cafecode/contracts/settings";
import { describe, expect, it } from "vitest";
import { getSettingsPageReset } from "./settingsReset";
const changed = {
  ...DEFAULT_UNIFIED_SETTINGS,
  ambianceOpacity: 0.55,
  ambianceAtriumEnabled: true,
  ambianceAtriumColor: "#abcdef",
  powerSaveBlockerMode: "always" as const,
  chatCopyFormat: "plainText" as const,
  addProjectBaseDirectory: "~/work",
  mcpEnabled: false,
};
describe("page-owned settings reset", () => {
  it("resets closed-lid work only when the native macOS capability is present", () => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, keepAwakeWithLidClosed: true };
    expect(getSettingsPageReset("/settings/general", settings, { desktop: true }).patch).toEqual(
      {},
    );
    expect(
      getSettingsPageReset("/settings/general", settings, { desktop: true, macKeepAwake: true })
        .patch,
    ).toEqual({ keepAwakeWithLidClosed: false });
  });
  it("resets every visual control without resetting the Atrium feature or other pages", () => {
    expect(getSettingsPageReset("/settings/appearance", changed, { desktop: true }).patch).toEqual({
      ambianceOpacity: DEFAULT_UNIFIED_SETTINGS.ambianceOpacity,
      ambianceAtriumColor: DEFAULT_UNIFIED_SETTINGS.ambianceAtriumColor,
    });
  });
  it("includes the Atrium feature and copy preference in Chats", () => {
    expect(
      getSettingsPageReset("/settings/chat-threads", changed, { desktop: true }).patch,
    ).toEqual({ ambianceAtriumEnabled: false, chatCopyFormat: "markdown" });
  });
  it("resets General project defaults and keeps desktop-only preferences out of web resets", () => {
    expect(getSettingsPageReset("/settings/general", changed, { desktop: false }).patch).toEqual({
      addProjectBaseDirectory: "",
    });
    expect(getSettingsPageReset("/settings/general", changed, { desktop: true }).patch).toEqual({
      addProjectBaseDirectory: "",
      powerSaveBlockerMode: "off",
    });
  });
  it("has no implicit global reset and renders labels in the requested locale", () => {
    expect(getSettingsPageReset("/settings/diagnostics", changed, { desktop: true }).patch).toEqual(
      {},
    );
    expect(
      getSettingsPageReset("/settings/general", changed, { desktop: true }, "ja").labels,
    ).toContain("既定のプロジェクトフォルダー");
    expect(
      getSettingsPageReset("/settings/general", DEFAULT_UNIFIED_SETTINGS, { desktop: true }).labels,
    ).toEqual([]);
  });
});
