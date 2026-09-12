import { describe, expect, it, vi } from "vitest";

import { lowerProviderDaemonPriority, PROVIDER_DAEMON_PRIORITY } from "./ProviderDaemonPriority.ts";

describe("provider daemon scheduling", () => {
  it("lowers only the current daemon from normal priority", () => {
    const setPriority = vi.fn();
    expect(lowerProviderDaemonPriority({ getPriority: () => 0, setPriority })).toBe("lowered");
    expect(setPriority).toHaveBeenCalledExactlyOnceWith(0, PROVIDER_DAEMON_PRIORITY);
  });

  it.each([PROVIDER_DAEMON_PRIORITY, 19])("preserves a launcher priority of %i", (priority) => {
    const setPriority = vi.fn();
    expect(lowerProviderDaemonPriority({ getPriority: () => priority, setPriority })).toBe(
      "already-lower",
    );
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("contains an unavailable priority read without changing a process", () => {
    const setPriority = vi.fn();
    expect(
      lowerProviderDaemonPriority({
        getPriority: () => {
          throw new Error("host diagnostic contains private data");
        },
        setPriority,
      }),
    ).toBe("unavailable");
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("contains a rejected priority write without exposing host diagnostics", () => {
    expect(
      lowerProviderDaemonPriority({
        getPriority: () => 0,
        setPriority: () => {
          throw new Error("host diagnostic contains private data");
        },
      }),
    ).toBe("unavailable");
  });
});
