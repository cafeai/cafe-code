import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as NetService from "@cafecode/shared/Net";
import { startStartupCpuProfiler } from "@cafecode/shared/startupProfiler";
import { APPLICATION_VERSION } from "./applicationVersion.ts";
import { authCommand } from "./cli/auth.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { killallCommand } from "./cli/killall.ts";
import { projectCommand } from "./cli/project.ts";
import { providerDaemonCommand, providerSupervisorCommand } from "./cli/providerDaemon.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { backendStartupTeardown } from "./backendStartupTeardown.ts";
import { installProcessShutdownObservation } from "./processShutdownObservation.ts";

function resolveStartupProfilerRole(argv: readonly string[]): string {
  if (argv.includes("provider-daemon")) return "provider-daemon";
  if (argv.includes("provider-supervisor")) return "provider-supervisor";
  return "server";
}

startStartupCpuProfiler({ role: resolveStartupProfilerRole(process.argv.slice(2)) });

// Project subcommands first probe the live server before falling back to the
// offline SQLite path. Keep the concrete HTTP implementation at the CLI
// composition root so every command branch has one explicit, scoped client.
const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer, FetchHttpClient.layer);

export const cli = Command.make("cafe-code", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Cafe Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    authCommand,
    killallCommand,
    projectCommand,
    providerDaemonCommand,
    providerSupervisorCommand,
  ]),
);

if (import.meta.main) {
  // Lets provider exit observers distinguish a planned stop from a crash. It
  // is installed beside runMain, which still owns signal-driven termination.
  installProcessShutdownObservation();
  Command.run(cli, { version: APPLICATION_VERSION }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain({ teardown: backendStartupTeardown }),
  );
}
