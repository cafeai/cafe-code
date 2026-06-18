import { EnvironmentId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for local projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        canOpenLocalEditor: true,
      }),
    ).toBe(true);
  });

  it("hides the picker for browser clients without a local editor bridge", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        canOpenLocalEditor: false,
      }),
    ).toBe(false);
  });

  it("hides the picker when no primary environment is available", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-stale"),
        primaryEnvironmentId: null,
        canOpenLocalEditor: true,
      }),
    ).toBe(false);
  });

  it("hides the picker for stale non-primary environment ids", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-stale"),
        primaryEnvironmentId,
        canOpenLocalEditor: true,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        canOpenLocalEditor: true,
      }),
    ).toBe(false);
  });
});
