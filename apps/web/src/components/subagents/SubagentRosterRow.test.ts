import { afterEach, describe, expect, it, vi } from "vitest";
import * as i18n from "@cafecode/shared/i18n";
import {
  isLiveSubagentStatus,
  subagentStatusLabel,
  SUBAGENT_STATUS_UNAVAILABLE_DETAIL,
  getSUBAGENT_STATUS_UNAVAILABLE_DETAIL,
} from "./SubagentRosterRow";

afterEach(() => vi.restoreAllMocks());

describe("subagent status presentation", () => {
  it.each([
    ["waiting", "Waiting", true],
    ["active", "Working", true],
    ["completed", "Done", false],
    ["failed", "Failed", false],
    ["stopped", "Stopped", false],
    ["unknown", "Status unavailable", false],
  ] as const)("keeps %s English label separate from liveness", (status, label, live) => {
    expect(subagentStatusLabel(status)).toBe(label);
    expect(isLiveSubagentStatus(status)).toBe(live);
  });

  it("retains literal apostrophe disclosure and does not grant liveness from a translated label", () => {
    expect(SUBAGENT_STATUS_UNAVAILABLE_DETAIL).toBe(
      "Cafe can't confirm whether this subagent is still running. Its saved summary is shown as last reported.",
    );
    expect(getSUBAGENT_STATUS_UNAVAILABLE_DETAIL()).toBe(SUBAGENT_STATUS_UNAVAILABLE_DETAIL);
    vi.spyOn(i18n, "uiText").mockReturnValue("Isolated translated status");
    expect(subagentStatusLabel("active")).toBe("Isolated translated status");
    expect(isLiveSubagentStatus("active")).toBe(true);
    expect(isLiveSubagentStatus("failed")).toBe(false);
    expect(isLiveSubagentStatus("unknown")).toBe(false);
    expect(
      isLiveSubagentStatus(
        "Isolated translated status" as Parameters<typeof isLiveSubagentStatus>[0],
      ),
    ).toBe(false);
  });
});
