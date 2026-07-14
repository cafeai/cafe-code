import { ProviderDaemonBootstrap } from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import {
  deriveServerPaths,
  ensureServerDirectories,
  ServerConfig,
  type ServerConfigShape,
} from "../config.ts";
import { runProviderDaemonServerForever } from "../providerDaemon/ProviderDaemonServer.ts";
import { ProviderDaemonRuntimeLive } from "../providerDaemon/ProviderDaemonRuntime.ts";
import { PROVIDER_SUPERVISOR_PROTOCOL_VERSION } from "../providerDaemon/ProviderSupervisorProcessManager.ts";
import { ObservabilityLive } from "../observability/Layers/Observability.ts";
import packageJson from "../../package.json" with { type: "json" };
import { bootstrapFdFlag } from "./config.ts";

class ProviderDaemonCliError extends Data.TaggedError("ProviderDaemonCliError")<{
  readonly message: string;
}> {}

const resolveProviderDaemonServerConfig = (input: {
  readonly bootstrap: ProviderDaemonBootstrap;
  readonly logLevel: LogLevel.LogLevel;
  readonly runtimeRole: "provider-daemon" | "provider-supervisor";
  readonly providerSupervisor?: ServerConfigShape["providerSupervisor"];
}): Effect.Effect<
  ServerConfigShape,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const baseDir = input.bootstrap.cafeCodeHome;
    const path = yield* Path.Path;
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    yield* ensureServerDirectories(derivedPaths);

    return {
      logLevel: input.logLevel,
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: input.bootstrap.otlpTracesUrl,
      otlpMetricsUrl: input.bootstrap.otlpMetricsUrl,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: `cafe-code-${input.runtimeRole}`,
      mode: "desktop",
      port: input.bootstrap.port ?? 1,
      httpsEnabled: false,
      httpsPort: undefined,
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      // Detached provider runtimes cannot safely depend on Electron-owned
      // stdout/stderr pipes. Give each runtime role a child-owned trace file so
      // diagnostics survive desktop restarts without two processes rotating the
      // backend's `server.trace.ndjson` concurrently.
      serverTracePath: path.join(derivedPaths.logsDir, `${input.runtimeRole}.trace.ndjson`),
      host: input.bootstrap.host ?? "127.0.0.1",
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "headless",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      providerDaemon: undefined,
      providerSupervisor: input.providerSupervisor,
    } satisfies ServerConfigShape;
  });

export const runProviderDaemonCommand = (flags: { readonly bootstrapFd: Option.Option<number> }) =>
  Effect.gen(function* () {
    const logLevelOption = yield* GlobalFlag.LogLevel;
    const logLevel = Option.getOrElse(logLevelOption, () => "Info" as const);
    const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd);
    if (bootstrapFd === undefined) {
      return yield* new ProviderDaemonCliError({
        message: "provider-daemon requires --bootstrap-fd.",
      });
    }

    const bootstrapEnvelope = yield* readBootstrapEnvelope(ProviderDaemonBootstrap, bootstrapFd);
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);
    if (bootstrap === undefined) {
      return yield* new ProviderDaemonCliError({
        message: "provider-daemon bootstrap envelope was not available.",
      });
    }
    if (bootstrap.mode !== "provider-daemon") {
      return yield* new ProviderDaemonCliError({
        message: `provider-daemon received invalid bootstrap mode ${bootstrap.mode}.`,
      });
    }

    const baseConfig = yield* resolveProviderDaemonServerConfig({
      bootstrap,
      logLevel,
      runtimeRole: "provider-daemon",
    });
    yield* Effect.logInfo("provider daemon using local provider runtime", {
      reason:
        "automatic provider-supervisor handoff is disabled until supervisor restart/fallback preserves the provider registry",
    });

    return yield* runProviderDaemonServerForever({
      mode: "provider-daemon",
      transport: bootstrap.transport ?? "tcp",
      ...(bootstrap.host !== undefined ? { host: bootstrap.host } : {}),
      ...(bootstrap.port !== undefined ? { port: bootstrap.port } : {}),
      ...(bootstrap.socketPath !== undefined ? { socketPath: bootstrap.socketPath } : {}),
      token: bootstrap.token,
      version: packageJson.version,
      protocolVersion: PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
      ...(bootstrap.runtimeBuildId !== undefined
        ? { runtimeBuildId: bootstrap.runtimeBuildId }
        : {}),
    }).pipe(
      Effect.provide(ProviderDaemonRuntimeLive),
      Effect.provide(ObservabilityLive),
      Effect.provideService(ServerConfig, baseConfig),
    );
  });

export const runProviderSupervisorCommand = (flags: {
  readonly bootstrapFd: Option.Option<number>;
}) =>
  Effect.gen(function* () {
    const logLevelOption = yield* GlobalFlag.LogLevel;
    const logLevel = Option.getOrElse(logLevelOption, () => "Info" as const);
    const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd);
    if (bootstrapFd === undefined) {
      return yield* new ProviderDaemonCliError({
        message: "provider-supervisor requires --bootstrap-fd.",
      });
    }

    const bootstrapEnvelope = yield* readBootstrapEnvelope(ProviderDaemonBootstrap, bootstrapFd);
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);
    if (bootstrap === undefined) {
      return yield* new ProviderDaemonCliError({
        message: "provider-supervisor bootstrap envelope was not available.",
      });
    }
    if (bootstrap.mode !== "provider-supervisor") {
      return yield* new ProviderDaemonCliError({
        message: `provider-supervisor received invalid bootstrap mode ${bootstrap.mode}.`,
      });
    }

    const config = yield* resolveProviderDaemonServerConfig({
      bootstrap,
      logLevel,
      runtimeRole: "provider-supervisor",
    });

    return yield* runProviderDaemonServerForever({
      mode: "provider-supervisor",
      transport: bootstrap.transport ?? "tcp",
      ...(bootstrap.host !== undefined ? { host: bootstrap.host } : {}),
      ...(bootstrap.port !== undefined ? { port: bootstrap.port } : {}),
      ...(bootstrap.socketPath !== undefined ? { socketPath: bootstrap.socketPath } : {}),
      token: bootstrap.token,
      version: packageJson.version,
      protocolVersion: PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
      ...(bootstrap.runtimeBuildId !== undefined
        ? { runtimeBuildId: bootstrap.runtimeBuildId }
        : {}),
    }).pipe(
      Effect.provide(ProviderDaemonRuntimeLive),
      Effect.provide(ObservabilityLive),
      Effect.provideService(ServerConfig, config),
    );
  });

export const providerDaemonCommand = Command.make("provider-daemon", {
  bootstrapFd: bootstrapFdFlag,
}).pipe(
  Command.withDescription("Run the minimal Cafe Code provider mini-daemon."),
  Command.withHandler((flags) => runProviderDaemonCommand(flags)),
);

export const providerSupervisorCommand = Command.make("provider-supervisor", {
  bootstrapFd: bootstrapFdFlag,
}).pipe(
  Command.withDescription("Run the detached Cafe Code provider supervisor."),
  Command.withHandler((flags) => runProviderSupervisorCommand(flags)),
);
