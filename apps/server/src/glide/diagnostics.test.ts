import { describe, expect, it } from "vitest";
import { makeGlideStartupDiagnostics } from "./diagnostics.ts";

describe("Glide startup observations", () => {
  it("retains independent finite failure phases without accepting native error content", () => {
    const diagnostics = makeGlideStartupDiagnostics();
    const before = diagnostics.snapshot();
    expect(before).toEqual({
      attachFailureCount: 0,
      activationFailureCount: 0,
      trayFailureCount: 0,
    });
    diagnostics.recordFailure("tray");
    diagnostics.recordFailure("activate");
    diagnostics.recordFailure("attach");
    diagnostics.recordFailure("activate");
    expect(diagnostics.snapshot()).toEqual({
      attachFailureCount: 1,
      activationFailureCount: 2,
      trayFailureCount: 1,
      lastFailurePhase: "activate",
    });
    // Previously read snapshots are values, not handles into mutable state.
    expect(before.activationFailureCount).toBe(0);
    const isolated = makeGlideStartupDiagnostics();
    expect(isolated.snapshot()).toEqual(before);
  });
});
