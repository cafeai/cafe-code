import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { DesktopResolution, VirtualDesktopRequest } from "./virtualDesktop.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeDesktopResolution = Schema.decodeUnknownSync(DesktopResolution);
const decodeVirtualDesktopRequest = Schema.decodeUnknownSync(VirtualDesktopRequest);

describe("desktop display contracts", () => {
  it("loads existing settings with the default resolution and accepts portrait configuration", () => {
    expect(decodeServerSettings({}).desktopDefaultResolution).toEqual({
      width: 1280,
      height: 800,
    });
    expect(
      decodeServerSettingsPatch({
        desktopDefaultResolution: { width: 720, height: 1280 },
      }),
    ).toEqual({ desktopDefaultResolution: { width: 720, height: 1280 } });
  });
  it.each([0, 319, 2049, 1080.5, Number.NaN, Number.POSITIVE_INFINITY, "1080"])(
    "rejects unsafe display dimensions: %s",
    (width) => {
      expect(() => decodeDesktopResolution({ width, height: 800 })).toThrow();
      expect(() =>
        decodeVirtualDesktopRequest({
          operation: "create",
          name: "Test",
          resolution: { width: 1280, height: width },
        }),
      ).toThrow();
    },
  );
  it("accepts exact display bounds through the management request", () => {
    expect(
      decodeVirtualDesktopRequest({
        operation: "create",
        resolution: { width: 320, height: 2048 },
      }),
    ).toMatchObject({ resolution: { width: 320, height: 2048 } });
  });
});
