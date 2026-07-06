import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@cafecode/shared/Net";
import { startStartupCpuProfiler } from "@cafecode/shared/startupProfiler";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { killallCommand } from "./cli/killall.ts";
import { projectCommand } from "./cli/project.ts";
import { providerDaemonCommand, providerSupervisorCommand } from "./cli/providerDaemon.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";

function resolveStartupProfilerRole(argv: readonly string[]): string {
  if (argv.includes("provider-daemon")) return "provider-daemon";
  if (argv.includes("provider-supervisor")) return "provider-supervisor";
  return "server";
}

startStartupCpuProfiler({ role: resolveStartupProfilerRole(process.argv.slice(2)) });

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

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
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
