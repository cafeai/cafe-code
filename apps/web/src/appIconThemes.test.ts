import { describe, expect, it } from "vitest";

import { themedAppIconKey, themedAppIconUrl } from "./appIconThemes";
import { SIDEBAR_IMAGE_COLOR_IDS } from "./sidebarImages";

describe("themed app icons", () => {
  it("ships Default and Dekai in every accent scene for both themes", () => {
    for (const variant of ["standard", "dekai"] as const) {
      for (const color of SIDEBAR_IMAGE_COLOR_IDS) {
        for (const theme of ["dark", "light"] as const) {
          expect(themedAppIconUrl(variant, color, theme)).toBeTruthy();
          // The key shape is what the desktop accepts (contracts/appIcon.ts).
          expect(themedAppIconKey(variant, color, theme)).toMatch(
            /^(?:standard|dekai)-[a-z]{1,16}-(?:dark|light)$/u,
          );
        }
      }
    }
  });
});
