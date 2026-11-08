/** Content-free process-local observations; these never grant access or retries. */
export function makeGlideStartupDiagnostics() {
  let attachFailureCount = 0;
  let activationFailureCount = 0;
  let trayFailureCount = 0;
  let lastFailurePhase: "attach" | "activate" | "tray" | undefined;
  const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  return {
    recordFailure(phase: "attach" | "activate" | "tray") {
      // Only Cafe-authored phases enter the snapshot. Native errors, owner IDs,
      // prompts, executable paths and credentials are deliberately not accepted.
      if (phase === "attach") attachFailureCount = increment(attachFailureCount);
      else if (phase === "activate") activationFailureCount = increment(activationFailureCount);
      else trayFailureCount = increment(trayFailureCount);
      lastFailurePhase = phase;
    },
    snapshot() {
      return {
        attachFailureCount,
        activationFailureCount,
        trayFailureCount,
        ...(lastFailurePhase === undefined ? {} : { lastFailurePhase }),
      };
    },
  };
}

const diagnostics = makeGlideStartupDiagnostics();
export const recordGlideStartupFailure = diagnostics.recordFailure;
export const recordGlideTrayFailure = () => diagnostics.recordFailure("tray");
export const readGlideStartupDiagnostics = diagnostics.snapshot;
