import { compareSemverVersions } from "@cafecode/shared/semver";
import { resolveCommandPath } from "@cafecode/shared/shell";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { AcpRequestError } from "effect-acp/errors";
// Native path boundary: retain the host's absolute path and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute } from "node:path";

import type { ManagementMcpBinding } from "../../mcp/sessionConnection.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { terminateProbeChild } from "../providerSnapshot.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const MINIMUM_VERSION = "1.5.9";
const VERSION_OUTPUT_BYTES = 4_096;
const CLI_VERSION_TIMEOUT = "8 seconds";
const CLI_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

export class GeminiCliQualificationError extends Data.TaggedError("GeminiCliQualificationError")<{
  readonly reason: "missing" | "unsupported" | "timeout" | "execution";
  readonly message: string;
}> {}

export function geminiCliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Canonicalize case aliases too: Windows may select a duplicate with a
  // different spelling before the canonical key reaches the child.
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => key.toUpperCase() !== CLI_UPDATE_ENV),
    ),
    [CLI_UPDATE_ENV]: "true",
  };
}

export const qualifyGeminiCli = Effect.fn("qualifyGeminiCli")(function* (
  configuredBinary: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const selected = expandHomePath(configuredBinary);
  // The standalone distribution uses a native executable. In particular,
  // do not invoke a Windows batch shim or let the project cwd choose a binary.
  const binaryPath = yield* Effect.sync(() =>
    resolveCommandPath(selected, { env: { ...environment, PATHEXT: ".EXE" } }),
  );
  if (!binaryPath || !isAbsolute(binaryPath)) {
    return yield* new GeminiCliQualificationError({
      reason: "missing",
      message: "Install the standalone Antigravity CLI or set its absolute executable path.",
    });
  }

  const probe = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(binaryPath, ["--version"], {
        cwd,
        env: geminiCliEnvironment(environment),
        extendEnv: false,
        stdin: "ignore",
      }),
    );
    return yield* Effect.all(
      {
        stdout: collectUint8StreamText({ stream: child.stdout, maxBytes: VERSION_OUTPUT_BYTES }),
        stderr: collectUint8StreamText({ stream: child.stderr, maxBytes: VERSION_OUTPUT_BYTES }),
        exitCode: child.exitCode,
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.ensuring(terminateProbeChild(child, "250 millis")));
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      () =>
        new GeminiCliQualificationError({
          reason: "execution",
          message: "Cafe Code could not run the configured Antigravity CLI version check.",
        }),
    ),
    Effect.timeoutOrElse({
      duration: CLI_VERSION_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new GeminiCliQualificationError({
            reason: "timeout",
            message: "Antigravity CLI did not finish its version check.",
          }),
        ),
    }),
  );

  const { stdout, stderr, exitCode } = yield* probe;
  // A bare stable version is a normal CLI response. Require the whole
  // response so the IDE launcher (version, commit and architecture lines)
  // cannot satisfy this check with a coincidentally higher editor version.
  const version =
    Number(exitCode) === 0 && !stdout.truncated && !stderr.truncated
      ? /^(?:(?:agy|Antigravity CLI)(?: version)?[: ]+)?v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/iu.exec(
          stdout.text.trim() || stderr.text.trim(),
        )?.[1]
      : undefined;
  if (!version || compareSemverVersions(version, MINIMUM_VERSION) < 0) {
    return yield* new GeminiCliQualificationError({
      reason: "unsupported",
      message: `Select the standalone Antigravity CLI ${MINIMUM_VERSION} or newer. The Antigravity IDE launcher cannot serve this provider.`,
    });
  }
  return { binaryPath, version };
});

type GeminiRuntimeOptions = Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn" | "authMethodId" | "beforeSession" | "mcpServers"
> & {
  readonly binaryPath: string;
  readonly bypassPermissions?: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly managementMcp?: ManagementMcpBinding;
};

export function makeGeminiAcpRuntime({
  binaryPath,
  bypassPermissions,
  environment,
  childProcessSpawner,
  managementMcp,
  ...options
}: GeminiRuntimeOptions) {
  return AcpSessionRuntime.make({
    ...options,
    // Session setup receives only the bridge's structured launch. Credentials
    // stay in its private connection file, outside ACP frames and profile config.
    ...(managementMcp
      ? {
          mcpServers: [
            {
              name: managementMcp.name,
              command: managementMcp.launch.command,
              args: [...managementMcp.launch.args],
              env: Object.entries(managementMcp.launch.env).map(([name, value]) => ({
                name,
                value,
              })),
            },
          ],
        }
      : {}),
    allowOverlappingPrompts: true,
    spawn: {
      command: binaryPath,
      // This is a process startup setting. The native mode selector exposes
      // Default in both processes and cannot establish or change Bypass.
      args: bypassPermissions === true ? ["acp", "--dangerously-skip-permissions"] : ["acp"],
      cwd: options.cwd,
      env: geminiCliEnvironment(environment),
      extendEnv: false,
    },
    // Account setup is external. Background discovery must never launch a
    // sign-in flow or pick a different credential from advertised methods.
    authMethodId: () => Effect.succeed(undefined),
    beforeSession: (initialize) => {
      const name = initialize.agentInfo?.name.trim().toLowerCase();
      const title = initialize.agentInfo?.title?.trim().toLowerCase();
      return initialize.protocolVersion === 1 &&
        (name === "antigravity-acp" ||
          name === "antigravity acp server" ||
          title === "antigravity acp server")
        ? Effect.void
        : Effect.fail(
            AcpRequestError.invalidRequest(
              "The configured executable did not identify an Antigravity ACP v1 server.",
            ),
          );
    },
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
}
