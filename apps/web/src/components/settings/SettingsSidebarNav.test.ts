import { describe, expect, it } from "vitest";

import { SETTINGS_NAV_GROUPS } from "./SettingsSidebarNav";

describe("SettingsSidebarNav", () => {
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
