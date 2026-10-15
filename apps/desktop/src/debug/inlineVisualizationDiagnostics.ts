/** Content-free browser-pool diagnostics. This is observed renderer work, not
 * process attestation, a memory quota or permission to execute received code. */
export function readInlineVisualizationDiagnostics(snapshot: unknown) {
  const field = (record: unknown, key: string): unknown => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const value = Object.getOwnPropertyDescriptor(record, key);
    return value && "value" in value && value.enumerable ? value.value : undefined;
  };
  const value = field(snapshot, "visualizations");
  const valid =
    field(value, "mode") === "inline-browser" && field(value, "fullAccessRequired") === true;
  const count = (name: string, maximum: number): number | null => {
    const amount = valid ? field(value, name) : undefined;
    return typeof amount === "number" &&
      Number.isSafeInteger(amount) &&
      amount >= 0 &&
      amount <= maximum
      ? amount
      : null;
  };
  return {
    mode: "inline-browser" as const,
    fullAccessRequired: true,
    nativeExecutionHost: false,
    available: valid,
    pools: count("pools", 16),
    anchors: count("anchors", 2048),
    grantedFrames: count("grantedFrames", 64),
    runningFrames: count("runningFrames", 64),
    activeReads: count("activeReads", 32),
    waitingReads: count("waitingReads", 128),
    diagnosticsConstrained: valid && field(value, "diagnosticsConstrained") === true,
  };
}
