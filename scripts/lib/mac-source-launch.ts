// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute, join, resolve } from "node:path";

const MAX_SOURCE_PATH_BYTES = 16 * 1024;

/** Match desktop lexical home expansion before LaunchServices loses cwd. */
export function resolveMacSourceConfiguredHome(
  raw: string | undefined,
  homeDirectory: string,
): string {
  const configured = raw?.trim() || join(homeDirectory, ".cafe-code");
  return resolve(
    configured === "~"
      ? homeDirectory
      : configured.startsWith("~/") || configured.startsWith("~\\")
        ? join(homeDirectory, configured.slice(2))
        : configured,
  );
}

export function macSourceLaunchArgs(input: {
  readonly appBundlePath: string;
  readonly runtimeBundlePath: string;
  readonly entryPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly configuredBaseDir: string;
  /** Explicit source-launcher executable lookup, never its full environment. */
  readonly pathEnvironment?: string | undefined;
  readonly args: readonly string[];
}): readonly string[] {
  // LaunchServices does not inherit the source launcher's working directory.
  for (const path of [
    input.appBundlePath,
    input.runtimeBundlePath,
    input.entryPath,
    input.stdoutPath,
    input.stderrPath,
    input.configuredBaseDir,
  ]) {
    if (!isAbsolute(path)) throw new Error("macOS source launch paths must be absolute.");
  }
  const pathEnvironment = input.pathEnvironment;
  if (
    pathEnvironment !== undefined &&
    (typeof pathEnvironment !== "string" ||
      pathEnvironment.length > MAX_SOURCE_PATH_BYTES ||
      Buffer.byteLength(pathEnvironment, "utf8") > MAX_SOURCE_PATH_BYTES ||
      /[\0\r\n]/u.test(pathEnvironment))
  ) {
    // This is a fixed error: PATH may contain private local names and must not
    // be echoed into logs, a native error dialog or a failed launch receipt.
    throw new Error("macOS source launch PATH is invalid.");
  }
  return [
    "-n",
    "-a",
    input.appBundlePath,
    "--stdout",
    input.stdoutPath,
    "--stderr",
    input.stderrPath,
    // Provider-backed restart commands inherit this flag. An empty value keeps
    // Electron in GUI mode when LaunchServices forwards the environment.
    "--env",
    "ELECTRON_RUN_AS_NODE",
    // LaunchServices forwards only an explicit, non-secret selection. Do not
    // depend on its inherited login environment to preserve a custom Cafe home
    // or forward the entire launching shell's provider credentials.
    "--env",
    `CAFE_CODE_HOME=${input.configuredBaseDir}`,
    "--env",
    "CAFE_CODE_DATA_PROFILE=debug",
    // `open` does not inherit the terminal's environment into its responsible
    // app. Preserve only this explicit executable lookup as one argv value;
    // the existing native host passes it to Electron and its daemon. Login
    // shell hydration still merges its result without losing this fallback.
    // Empty/absent PATH retains the historical LaunchServices/login behavior.
    ...(pathEnvironment === undefined || pathEnvironment.length === 0
      ? []
      : ["--env", `PATH=${pathEnvironment}`]),
    "--args",
    "--cafe-source-runtime",
    input.runtimeBundlePath,
    "--cafe-source-entry",
    input.entryPath,
    ...input.args,
  ];
}
