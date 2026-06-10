import { ProviderDaemonBootstrap, type ProviderDaemonSupervisorProcess } from "@cafecode/contracts";
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
import {
  ensureProviderSupervisorProcess,
  PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
  type ProviderSupervisorProcessSnapshot,
} from "../providerDaemon/ProviderSupervisorProcessManager.ts";
import packageJson from "../../package.json" with { type: "json" };
import { bootstrapFdFlag } from "./config.ts";

class ProviderDaemonCliError extends Data.TaggedError("ProviderDaemonCliError")<{
  readonly message: string;
}> {}

function sanitizeSupervisorProcessSnapshot(
  input: ProviderSupervisorProcessSnapshot,
): ProviderDaemonSupervisorProcess {
  return {
    status: input.status,
    pid: input.pid,
    httpBaseUrl: input.endpoint.httpBaseUrl,
    transport: input.endpoint.transport,
    ...(input.endpoint.socketPath === null ? {} : { socketPath: input.endpoint.socketPath }),
    ...(input.endpoint.leaseId === null ? {} : { leaseId: input.endpoint.leaseId }),
    markerPath: input.markerPath,
    appVersion: input.appVersion,
    protocolVersion: input.protocolVersion,
    ...(input.runtimeBuildId !== undefined ? { runtimeBuildId: input.runtimeBuildId } : {}),
    adoptedExistingProcess: input.adoptedExistingProcess,
    durationMs: input.durationMs,
  };
}

const resolveProviderDaemonServerConfig = (input: {
  readonly bootstrap: ProviderDaemonBootstrap;
  readonly logLevel: LogLevel.LogLevel;
  readonly providerSupervisor?: ServerConfigShape["providerSupervisor"];
}): Effect.Effect<
  ServerConfigShape,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const baseDir = input.bootstrap.cafeCodeHome;
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
      otlpServiceName: "cafe-code-provider-daemon",
      mode: "desktop",
      port: input.bootstrap.port ?? 1,
      httpsEnabled: false,
      httpsPort: undefined,
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      serverTracePath: derivedPaths.serverTracePath,
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
    });
    const supervisor = yield* ensureProviderSupervisorProcess({
      config: baseConfig,
      version: packageJson.version,
      ...(bootstrap.runtimeBuildId !== undefined
        ? { runtimeBuildId: bootstrap.runtimeBuildId }
        : {}),
    });
    yield* Effect.logInfo("provider daemon connected to detached provider supervisor", {
      supervisorPid: supervisor.snapshot.pid,
      adoptedExistingProcess: supervisor.snapshot.adoptedExistingProcess,
      durationMs: supervisor.snapshot.durationMs,
      transport: supervisor.snapshot.endpoint.transport,
      socketPath: supervisor.snapshot.endpoint.socketPath,
    });
    const config: ServerConfigShape = {
      ...baseConfig,
      providerSupervisor: supervisor.endpoint,
    };

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
      supervisorProcess: sanitizeSupervisorProcessSnapshot(supervisor.snapshot),
    }).pipe(Effect.provide(ProviderDaemonRuntimeLive), Effect.provideService(ServerConfig, config));
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
    }).pipe(Effect.provide(ProviderDaemonRuntimeLive), Effect.provideService(ServerConfig, config));
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
