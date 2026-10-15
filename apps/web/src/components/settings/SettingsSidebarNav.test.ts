import { describe, expect, it } from "vitest";

import { SETTINGS_NAV_GROUPS } from "./SettingsSidebarNav";

describe("SettingsSidebarNav", () => {
  it("groups related pages and preserves active legacy destinations", () => {
    const items = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);
    expect(items).toHaveLength(13);
    expect(items.find((item) => item.label === "General")?.activePaths).toEqual([
      "/settings/files",
      "/settings/system",
    ]);
    expect(items.find((item) => item.label === "Appearance")?.activePaths).toEqual([
      "/settings/ambiance",
    ]);
    expect(items.find((item) => item.label === "History")?.activePaths).toEqual([
      "/settings/recently-deleted",
    ]);
    expect(items.find((item) => item.to === "/settings/connections")?.label).toBe(
      "Connections & remote access",
    );
  });
  it("places Dictation in the AI and integrations settings group", () => {
    const integrations = SETTINGS_NAV_GROUPS.find((group) => group.label === "AI & Integrations");

    expect(integrations?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Dictation",
          to: "/settings/dictation",
        }),
      ]),
    );
  });
});
