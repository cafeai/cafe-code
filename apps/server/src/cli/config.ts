import * as NetService from "@cafecode/shared/Net";
import { cafeCodeConfigWithDefault, cafeCodeOptionalValueConfig } from "@cafecode/shared/compatEnv";
import { parsePersistedServerObservabilitySettings } from "@cafecode/shared/serverSettings";
import { DesktopBackendBootstrap, PortSchema } from "@cafecode/contracts";
import {
  preferredDataProfileHttpPort,
  resolveBootstrappedDataProfile,
  resolveDataProfileRoot,
  type DataProfile,
} from "@cafecode/shared/dataProfile";
import { prepareDebugDataProfile } from "@cafecode/shared/dataProfileStorage";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Argument, Flag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  RuntimeMode,
  type ServerConfigShape,
  type StartupPresentation,
} from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";

export const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
export const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
export const httpsPortFlag = Flag.integer("https-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTPS/WSS server."),
  Flag.optional,
);
export const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
export const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (env: CAFE_CODE_HOME)."),
  Flag.optional,
);
const DataProfileSchema = Schema.Literals(["production", "debug"]);
export const dataProfileFlag = Flag.choice("data-profile", DataProfileSchema.literals).pipe(
  Flag.withDescription(
    "Data profile beneath the configured Cafe home (env: CAFE_CODE_DATA_PROFILE).",
  ),
  Flag.optional,
);

export class DataProfileSelectionError extends Data.TaggedError("DataProfileSelectionError")<{
  readonly message: string;
}> {}
export const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Development web URL to proxy/redirect to."),
  Flag.optional,
);
export const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
export const noHttpsFlag = Flag.boolean("no-https").pipe(
  Flag.withDescription("Disable the self-signed HTTPS/WSS sibling listener."),
  Flag.optional,
);
export const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
export const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
export const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (env: CAFE_CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

const EnvServerConfig = Config.all({
  logLevel: cafeCodeConfigWithDefault("CAFE_CODE_LOG_LEVEL", Config.logLevel, "Info"),
  traceMinLevel: cafeCodeConfigWithDefault("CAFE_CODE_TRACE_MIN_LEVEL", Config.logLevel, "Info"),
  traceTimingEnabled: cafeCodeConfigWithDefault(
    "CAFE_CODE_TRACE_TIMING_ENABLED",
    Config.boolean,
    true,
  ),
  traceFile: cafeCodeOptionalValueConfig("CAFE_CODE_TRACE_FILE", Config.string),
  traceMaxBytes: cafeCodeConfigWithDefault(
    "CAFE_CODE_TRACE_MAX_BYTES",
    Config.int,
    10 * 1024 * 1024,
  ),
  traceMaxFiles: cafeCodeConfigWithDefault("CAFE_CODE_TRACE_MAX_FILES", Config.int, 10),
  traceBatchWindowMs: cafeCodeConfigWithDefault("CAFE_CODE_TRACE_BATCH_WINDOW_MS", Config.int, 200),
  otlpTracesUrl: cafeCodeOptionalValueConfig("CAFE_CODE_OTLP_TRACES_URL", Config.string),
  otlpMetricsUrl: cafeCodeOptionalValueConfig("CAFE_CODE_OTLP_METRICS_URL", Config.string),
  otlpExportIntervalMs: cafeCodeConfigWithDefault(
    "CAFE_CODE_OTLP_EXPORT_INTERVAL_MS",
    Config.int,
    10_000,
  ),
  otlpServiceName: cafeCodeConfigWithDefault(
    "CAFE_CODE_OTLP_SERVICE_NAME",
    Config.string,
    "cafe-code-server",
  ),
  mode: cafeCodeOptionalValueConfig("CAFE_CODE_MODE", (name) => Config.schema(RuntimeMode, name)),
  port: cafeCodeOptionalValueConfig("CAFE_CODE_PORT", Config.port),
  httpsEnabled: cafeCodeOptionalValueConfig("CAFE_CODE_HTTPS_ENABLED", Config.boolean),
  httpsPort: cafeCodeOptionalValueConfig("CAFE_CODE_HTTPS_PORT", Config.port),
  host: cafeCodeOptionalValueConfig("CAFE_CODE_HOST", Config.string),
  cafeCodeHome: cafeCodeOptionalValueConfig("CAFE_CODE_HOME", Config.string),
  dataProfile: cafeCodeOptionalValueConfig("CAFE_CODE_DATA_PROFILE", (name) =>
    Config.schema(DataProfileSchema, name),
  ),
  devUrl: Config.url("CAFE_CODE_DEV_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: cafeCodeOptionalValueConfig("CAFE_CODE_NO_BROWSER", Config.boolean),
  bootstrapFd: cafeCodeOptionalValueConfig("CAFE_CODE_BOOTSTRAP_FD", Config.int),
  autoBootstrapProjectFromCwd: cafeCodeOptionalValueConfig(
    "CAFE_CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
    Config.boolean,
  ),
  logWebSocketEvents: cafeCodeOptionalValueConfig("CAFE_CODE_LOG_WS_EVENTS", Config.boolean),
});

export interface CliServerFlags {
  readonly dataProfile?: Option.Option<DataProfile>;
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly httpsPort: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly noHttps: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

export interface CliAuthLocationFlags {
  readonly dataProfile?: Option.Option<DataProfile>;
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

export const sharedServerLocationFlags = {
  dataProfile: dataProfileFlag,
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

export const projectLocationFlags = {
  dataProfile: dataProfileFlag,
  baseDir: baseDirFlag,
} as const;

export const sharedServerCommandFlags = {
  dataProfile: dataProfileFlag,
  mode: modeFlag,
  port: portFlag,
  httpsPort: httpsPortFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  noHttps: noHttpsFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

export const authLocationFlags = sharedServerLocationFlags;

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const defaultHttpsPortStart = (
  mode: RuntimeMode,
  httpPort: number,
  dataProfile: DataProfile | undefined,
): number => {
  const offset = mode === "desktop" ? 2 : 1;
  const preferred = httpPort + offset;
  return preferred <= 65_535 ? preferred : preferredDataProfileHttpPort(dataProfile) + offset;
};

/** Debug defaults never fall back into the release's preferred range, even
 * when an OS has a customized ephemeral-port range. These probes are only a
 * preflight, not a reservation; the real listener still owns final admission.
 * A later bind race must fail, never adopt a service found on that endpoint. */
const findAvailableDebugPort = Effect.fn(function* (startPort: number, excludedPort?: number) {
  const net = yield* NetService.NetService;
  for (let port = startPort; port <= 65_535; port += 1) {
    if (port === excludedPort) continue;
    let available = true;
    for (const host of ["127.0.0.1", "0.0.0.0", "::"] as const) {
      if (!(yield* net.canListenOnHost(port, host))) {
        available = false;
        break;
      }
    }
    if (available) return port;
  }
  return yield* new DataProfileSelectionError({
    message:
      "No Debug server port is available. No other data profile or listening service was selected.",
  });
});

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService.NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      dataProfile: flags.dataProfile ?? Option.none(),
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      httpsPort: flags.httpsPort ?? Option.none(),
      host: flags.host ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      noHttps: flags.noHttps ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(DesktopBackendBootstrap, bootstrapFd).pipe(
            // Schema/IO causes can contain the private envelope. Keep its
            // per-spawn readiness key out of startup logs and public errors.
            Effect.mapError(
              () =>
                new DataProfileSelectionError({
                  message:
                    "Desktop backend private bootstrap is invalid or unavailable. No profile was opened.",
                }),
            ),
          )
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);
    const admittedBootstrap =
      bootstrap === undefined
        ? undefined
        : yield* Effect.try({
            try: () => resolveBootstrappedDataProfile(bootstrap, path),
            catch: () =>
              new DataProfileSelectionError({
                message:
                  "Desktop data profile bootstrap is incomplete or inconsistent. No profile was opened.",
              }),
          });
    const dataProfile =
      bootstrap === undefined
        ? (Option.getOrUndefined(normalizedFlags.dataProfile) ?? env.dataProfile)
        : admittedBootstrap!.dataProfile;
    // A private desktop bootstrap is authoritative. Reject conflicting ambient
    // selectors before settings, SQLite, logging or directory creation. A legacy
    // private bootstrap already names its effective root: ambient profile intent
    // cannot retroactively attest that parent or append another Debug suffix.
    // Only standalone invocations preserve public flag/environment precedence.
    if (bootstrap !== undefined) {
      const profileCandidates = [
        Option.getOrUndefined(normalizedFlags.dataProfile),
        env.dataProfile,
      ];
      if (
        profileCandidates.some((value) => value !== undefined && value !== bootstrap.dataProfile)
      ) {
        return yield* new DataProfileSelectionError({
          message:
            "Desktop data profile conflicts with its private bootstrap. No profile was opened.",
        });
      }
      for (const candidate of [Option.getOrUndefined(normalizedFlags.baseDir), env.cafeCodeHome]) {
        if (
          candidate !== undefined &&
          path.resolve(yield* resolveBaseDir(candidate)) !==
            path.resolve(admittedBootstrap!.configuredBaseDir)
        ) {
          return yield* new DataProfileSelectionError({
            message:
              "Desktop data root conflicts with its private bootstrap. No profile was opened.",
          });
        }
      }
    }

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop" && dataProfile !== "debug") {
            return Effect.succeed(DEFAULT_PORT);
          }
          // Debug never consumes the release's preferred listener merely
          // because it started first. Explicit operator ports remain exact.
          return dataProfile === "debug"
            ? findAvailableDebugPort(preferredDataProfileHttpPort(dataProfile))
            : findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    const configuredBaseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          admittedBootstrap !== undefined
            ? Option.some(admittedBootstrap!.configuredBaseDir)
            : Option.none(),
          normalizedFlags.baseDir,
          Option.fromUndefinedOr(env.cafeCodeHome),
          Option.fromUndefinedOr(bootstrap?.cafeCodeHome),
        ),
      ),
    );
    const baseDir =
      dataProfile === undefined
        ? configuredBaseDir
        : resolveDataProfileRoot(configuredBaseDir, dataProfile, path);
    if (dataProfile === "debug") {
      yield* Effect.tryPromise({
        try: () => prepareDebugDataProfile(configuredBaseDir),
        catch: () =>
          new DataProfileSelectionError({
            message:
              "Debug data profile is unavailable or unsafe. Check its permissions and free space. Production data was not selected.",
          }),
      });
    }
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl, dataProfile);
    yield* ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
      ),
      () => mode === "desktop",
    );
    const httpsEnabled = Option.getOrElse(
      resolveOptionPrecedence(
        Option.map(normalizedFlags.noHttps, (value) => !value),
        Option.fromUndefinedOr(env.httpsEnabled),
      ),
      () => true,
    );
    const httpsPort = httpsEnabled
      ? yield* Option.match(
          resolveOptionPrecedence(
            normalizedFlags.httpsPort,
            Option.fromUndefinedOr(env.httpsPort),
            Option.fromUndefinedOr(bootstrap?.httpsPort),
          ),
          {
            onSome: (value) => Effect.succeed(value),
            onNone: () =>
              dataProfile === "debug"
                ? findAvailableDebugPort(defaultHttpsPortStart(mode, port, dataProfile), port)
                : findAvailablePort(defaultHttpsPortStart(mode, port, dataProfile)),
          },
        )
      : undefined;
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      // Source/headless Debug is private by default too. A separate profile
      // must not inherit standalone web's wildcard listener as implicit LAN
      // consent; an explicit host remains the operator's deliberate override.
      () => (mode === "desktop" || dataProfile === "debug" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfigShape = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl:
        env.otlpTracesUrl ??
        bootstrap?.otlpTracesUrl ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        env.otlpMetricsUrl ??
        bootstrap?.otlpMetricsUrl ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpExportIntervalMs: env.otlpExportIntervalMs,
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      httpsEnabled,
      httpsPort,
      cwd,
      baseDir,
      ...(dataProfile === undefined ? {} : { dataProfile, configuredBaseDir }),
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      ...(mode === "desktop" && bootstrap?.desktopReadinessToken !== undefined
        ? { desktopReadinessToken: bootstrap.desktopReadinessToken }
        : {}),
      ...(mode === "desktop" && bootstrap?.startupProgressFd === 4
        ? { startupProgressFd: 4 as const }
        : {}),
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      providerDaemon: bootstrap?.providerDaemon,
      providerSupervisor: undefined,
    };

    return config;
  });

export const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.none(),
      httpsPort: Option.none(),
      host: Option.none(),
      baseDir: flags.baseDir,
      dataProfile: flags.dataProfile ?? Option.none(),
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: Option.none(),
      noHttps: Option.some(true),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
    },
    cliLogLevel,
  );

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(value), {
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);
