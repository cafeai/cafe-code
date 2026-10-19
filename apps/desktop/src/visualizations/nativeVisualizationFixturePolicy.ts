/** Policies for the explicit, disposable native qualification entrypoints only.
 * Production launch and retained private chart replay must never import this
 * module. Selecting a CPU graphics driver is test infrastructure, not a fallback
 * for arbitrary received visualization source or a new application permission. */
export type NativeVisualizationFixtureKind =
  | "comprehensive"
  | "synthetic-bar"
  | "exact-bar"
  | "font";

export type NativeVisualizationFixtureGraphics = "native-default" | "sandboxed-swiftshader";

/** The explicit full GLES driver exercises actual GL on GPU-less Linux bots.
 * Electron 42.11.15 retains Chromium 148.0.7778.280's base with backported
 * security fixes. Its docs/gpu/swiftshader.md
 * distinguishes this mode from the unsafe WebGL-only fallback, and
 * ui/gl/gl_features.cc:IsSwiftShaderAllowedByCommandLine plus
 * gpu/config/gpu_util.cc:ComputeGpuFeatureInfo admit the explicit driver without
 * an unsafe-fallback switch. This still executes CPU JIT graphics code: confine
 * it to trusted synthetic fixture bytes, retain the GPU/renderer sandbox, and
 * require actual native mode/sandbox observations before any source is run.
 * https://github.com/chromium/chromium/blob/148.0.7778.280/docs/gpu/swiftshader.md
 * https://github.com/electron/electron/blob/v42.11.15/DEPS
 * Unknown future kinds are deliberately not equivalent to synthetic source. */
export function nativeVisualizationFixtureDriver(
  platform: string,
  kind: string,
): readonly (readonly [string, string])[] {
  return platform === "linux" && ["comprehensive", "synthetic-bar", "font"].includes(kind)
    ? [
        ["use-gl", "angle"],
        ["use-angle", "swiftshader"],
      ]
    : [];
}

/** Apply only these fixed switches, before app readiness. Inherited unsafe or
 * conflicting modes are refusals, never repaired by overwriting a user's flags.
 * The opt-in wrapper constructs its command and scrubbed environment itself;
 * this additional guard makes the dedicated entrypoint fail closed as well. */
export function configureNativeVisualizationFixtureDriver(
  app: {
    isReady(): boolean;
    commandLine: {
      hasSwitch(name: string): boolean;
      appendSwitch(name: string, value: string): void;
    };
  },
  platform: string,
  kind: NativeVisualizationFixtureKind,
): boolean {
  const switches = nativeVisualizationFixtureDriver(platform, kind);
  if (switches.length === 0) return false;
  if (
    app.isReady() ||
    [
      "use-gl",
      "use-angle",
      "no-sandbox",
      "disable-gpu-sandbox",
      "in-process-gpu",
      "single-process",
      "disable-web-security",
      "enable-unsafe-swiftshader",
    ].some((name) => app.commandLine.hasSwitch(name))
  )
    throw new Error("Native fixture graphics policy refused.");
  for (const [name, value] of switches) app.commandLine.appendSwitch(name, value);
  return true;
}

/** An observed native result is required, not the requested command line or a
 * renderer-controlled canvas claim. The pinned native GPUInfo serializer emits
 * auxAttributes and the exact GLImplementationParts::ToString tuple below.
 * No machine names, arbitrary driver strings or native object escape this read.
 * https://github.com/chromium/chromium/blob/148.0.7778.280/gpu/config/gpu_info.cc
 * https://github.com/chromium/chromium/blob/148.0.7778.280/ui/gl/gl_implementation.cc */
export function isSandboxedNativeFixtureDriver(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const auxiliary = Reflect.get(value, "auxAttributes");
  if (auxiliary === null || typeof auxiliary !== "object" || Array.isArray(auxiliary)) return false;
  return (
    Reflect.get(auxiliary, "sandboxed") === true &&
    Reflect.get(auxiliary, "inProcessGpu") === false &&
    Reflect.get(auxiliary, "glImplementationParts") === "(gl=egl-angle,angle=swiftshader)"
  );
}

/** Only the two exact Chromium D-Bus observations already preserved in hosted
 * Linux evidence are benign here. An arbitrary stderr prefix, future source
 * line, SSL/GPU error or unwitnessed crash remains a failure. An exact pinned
 * Linux crash message additionally requires the fixture's positively observed
 * owned request/retirement PID witness, once per PID, never source consistency.
 * https://github.com/chromium/chromium/blob/148.0.7778.280/content/child/child_thread_impl.cc#L375
 * Fixture classification text itself never authorizes success. This
 * is not a logging suppressor: callers preserve every admitted raw byte and all
 * rejected raw streams before interpreting the report. Other platforms retain
 * the existing empty-stderr contract. Limits match the original child buffer. */
export function hasOnlyKnownNativeFixtureDiagnostics(
  stderr: string,
  platform: string,
  retirementPids: unknown = [],
): boolean {
  if (stderr.length > 65_536 || new TextEncoder().encode(stderr).byteLength > 65_536) return false;
  if (!Array.isArray(retirementPids) || retirementPids.length > 3) return false;
  const expected = new Set<number>();
  for (let index = 0; index < retirementPids.length; index++) {
    const pid: unknown = retirementPids[index];
    if (
      !Object.hasOwn(retirementPids, index) ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pid > 2_147_483_647 ||
      expected.has(pid)
    )
      return false;
    expected.add(pid);
  }
  if (stderr.trim() === "") return expected.size === 0;
  if (platform !== "linux") return false;
  const lines = stderr.split(/\r?\n/);
  if (lines.length > 128) return false;
  const prefix =
    /^\[[1-9][0-9]{0,9}:[0-9]{4}\/[0-9]{6}\.[0-9]{6}:ERROR:dbus\/(bus\.cc:406|object_proxy\.cc:572)\] (.*)$/;
  const crashes = new Set<number>();
  const valid = lines.every((line) => {
    if (line.trim() === "") return true;
    const crash =
      /^\[([1-9][0-9]{0,9}):[0-9]{4}\/[0-9]{6}\.[0-9]{6}:FATAL:content\/child\/child_thread_impl\.cc:377\] Crashing because hung$/.exec(
        line,
      );
    if (crash) {
      const pid = Number(crash[1]);
      if (!expected.has(pid) || crashes.has(pid)) return false;
      crashes.add(pid);
      return true;
    }
    const match = prefix.exec(line);
    return match?.[1] === "bus.cc:406"
      ? match[2] ===
          'Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")'
      : match?.[1] === "object_proxy.cc:572" &&
          match[2] ===
            "Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: ";
  });
  // Missing native crash evidence cannot be hidden by an otherwise successful
  // report, and duplicate lines cannot share a one-shot retirement witness.
  return valid && crashes.size === expected.size;
}

/** Fixed finite capture failure evidence distinguishes the previously unknown
 * failing clause without modifying capture admission, retrying or printing
 * source/PNG/error objects. Invalid native fields remain explicit nulls. */
export function nativeFixtureClippedCaptureObservation(value: {
  ownerZoom: unknown;
  displayDpr: unknown;
  expectedWidth: unknown;
  expectedHeight: unknown;
  capturePresent: boolean;
  reportedWidth: unknown;
  reportedHeight: unknown;
  encodedWidth: unknown;
  encodedHeight: unknown;
  sampleBgra: unknown;
  captureOutcome: unknown;
}): Record<string, unknown> {
  const integer = (scalar: unknown, maximum: number) =>
    typeof scalar === "number" && Number.isSafeInteger(scalar) && scalar >= 0 && scalar <= maximum
      ? scalar
      : null;
  const scalar = (number: unknown, minimum: number, maximum: number) =>
    typeof number === "number" && Number.isFinite(number) && number >= minimum && number <= maximum
      ? number
      : null;
  const sample = value.sampleBgra;
  const channels =
    Array.isArray(sample) &&
    sample.length === 4 &&
    [0, 1, 2, 3].every((index) => Object.hasOwn(sample, index))
      ? [sample[0], sample[1], sample[2], sample[3]]
      : undefined;
  return {
    ownerZoom: scalar(value.ownerZoom, 0.5, 2),
    displayDpr: scalar(value.displayDpr, 0.5, 4),
    expectedWidth: integer(value.expectedWidth, 1600),
    expectedHeight: integer(value.expectedHeight, 2000),
    capturePresent: value.capturePresent === true,
    reportedWidth: integer(value.reportedWidth, 1600),
    reportedHeight: integer(value.reportedHeight, 2000),
    encodedWidth: integer(value.encodedWidth, 1600),
    encodedHeight: integer(value.encodedHeight, 2000),
    sampleBgra:
      channels && channels.every((channel) => integer(channel, 255) !== null) ? channels : null,
    captureOutcome: ["not-attempted", "native-error", "empty", "encoding-error", "ready"].includes(
      value.captureOutcome as string,
    )
      ? value.captureOutcome
      : "unknown",
  };
}
