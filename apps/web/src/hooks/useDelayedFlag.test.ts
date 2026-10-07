import { describe, expect, it } from "vitest";

import { nextDelayedFlagStep } from "./useDelayedFlag";

const timing = { delayMs: 250, minVisibleMs: 300 };

describe("nextDelayedFlagStep", () => {
  it("does nothing while idle and hidden", () => {
    expect(nextDelayedFlagStep(false, { visible: false, shownAtMs: null }, 0, timing)).toEqual({
      kind: "settled",
    });
  });

  it("schedules showing after the delay when work starts", () => {
    expect(nextDelayedFlagStep(true, { visible: false, shownAtMs: null }, 1_000, timing)).toEqual({
      kind: "schedule",
      afterMs: 250,
      next: { visible: true, shownAtMs: 1_250 },
    });
  });

  it("stays visible while work continues", () => {
    expect(nextDelayedFlagStep(true, { visible: true, shownAtMs: 1_250 }, 2_000, timing)).toEqual({
      kind: "settled",
    });
  });

  it("keeps a just-shown indicator up for the minimum visible time", () => {
    expect(nextDelayedFlagStep(false, { visible: true, shownAtMs: 1_250 }, 1_350, timing)).toEqual({
      kind: "schedule",
      afterMs: 200,
      next: { visible: false, shownAtMs: null },
    });
  });

  it("hides immediately once the minimum visible time has passed", () => {
    expect(nextDelayedFlagStep(false, { visible: true, shownAtMs: 1_250 }, 5_000, timing)).toEqual({
      kind: "schedule",
      afterMs: 0,
      next: { visible: false, shownAtMs: null },
    });
  });
});
