import { afterEach, describe, expect, it, vi } from "vitest";
import { isPidAlive } from "./DesktopProcessReaper.ts";

afterEach(() => vi.restoreAllMocks());

describe("DesktopProcessReaper observational liveness", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "does not even probe an invalid PID %s",
    (pid) => {
      const signal = vi.spyOn(process, "kill").mockReturnValue(true);
      expect(isPidAlive(pid)).toBe(false);
      expect(signal).not.toHaveBeenCalled();
    },
  );

  it("probes presence without obtaining process-control authority", () => {
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(isPidAlive(12345)).toBe(true);
    expect(signal.mock.calls).toEqual([[12345, 0]]);
  });

  it("treats denied or absent liveness as inconclusive without sending a signal", () => {
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("synthetic absent or denied owner");
    });
    expect(isPidAlive(12345)).toBe(false);
    expect(signal.mock.calls).toEqual([[12345, 0]]);
  });
});
