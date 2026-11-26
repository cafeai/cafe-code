import { compareSemverVersions } from "@cafecode/shared/semver";
import { resolveCommandPath } from "@cafecode/shared/shell";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { AcpRequestError } from "effect-acp/errors";
// Native path boundary: retain the host's absolute path and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute } from "node:path";
// Native storage scope is content-free and must not expose the server home path.
import { createHash } from "node:crypto";

import type { ManagementMcpBinding } from "../../mcp/sessionConnection.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { terminateProbeChild } from "../providerSnapshot.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const MINIMUM_VERSION = "1.5.9";
const MINIMUM_PRIVATE_HOME_VERSION = "1.5.16";
const VERSION_OUTPUT_BYTES = 4_096;
const CLI_VERSION_TIMEOUT = "8 seconds";
const CLI_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";
const CLI_FILE_AUTH_ENV = "AGY_CLI_FORCE_FILE_TOKEN_STORAGE";

export class GeminiCliQualificationError extends Data.TaggedError("GeminiCliQualificationError")<{
  readonly reason: "missing" | "unsupported" | "timeout" | "execution" | "private-home-unsupported";
  readonly message: string;
}> {}

export function geminiPrivateHomeScope(nativeHome: string | undefined): string | undefined {
  return nativeHome === undefined
    ? undefined
    : createHash("sha256").update(nativeHome).digest("hex");
}

export function geminiPrivateHomeArgs(nativeHome: string | undefined): ReadonlyArray<string> {
  // 1.5.16 accepts the underscore spelling for ACP and for headless /usage.
  // The hyphenated spelling is ACP-only on that build.
  return nativeHome === undefined ? [] : ["--gemini_dir", nativeHome];
}

export function geminiCliEnvironment(
  environment: NodeJS.ProcessEnv,
  nativeHome?: string,
): NodeJS.ProcessEnv {
  // Canonicalize case aliases too: Windows may select a duplicate with a
  // different spelling before the canonical key reaches the child.
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => {
        const canonical = key.toUpperCase();
        return canonical !== CLI_UPDATE_ENV && !(nativeHome && canonical === CLI_FILE_AUTH_ENV);
      }),
    ),
    [CLI_UPDATE_ENV]: "true",
    ...(nativeHome ? { [CLI_FILE_AUTH_ENV]: "1" } : {}),
  };
}

export const qualifyGeminiCli = Effect.fn("qualifyGeminiCli")(function* (
  configuredBinary: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  nativeHome?: string,
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
  // Private homes use `--gemini_dir` together with
  // `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`, which forces file-based OAuth token
  // storage inside that directory instead of the OS keychain/credential store
  // across macOS, Linux, and Windows. Google 1.5.16 updated SSH/keychain
  // handling and accepts `--gemini_dir` for ACP, `--login`, and `/usage`.
  // https://antigravity.google/docs/changelog#v1516
  if (nativeHome && compareSemverVersions(version, MINIMUM_PRIVATE_HOME_VERSION) < 0) {
    return yield* new GeminiCliQualificationError({
      reason: "private-home-unsupported",
      message: `Private Antigravity homes require Antigravity CLI ${MINIMUM_PRIVATE_HOME_VERSION} or newer. Update the CLI, or add an instance that uses the existing native home.`,
    });
  }
  return { binaryPath, version, nativeHome };
});

type GeminiRuntimeOptions = Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn" | "authMethodId" | "beforeSession" | "mcpServers"
> & {
  readonly binaryPath: string;
  readonly nativeHome?: string | undefined;
  readonly bypassPermissions?: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly managementMcp?: ManagementMcpBinding;
};

export function makeGeminiAcpRuntime({
  binaryPath,
  nativeHome,
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
      args: [
        "acp",
        ...geminiPrivateHomeArgs(nativeHome),
        ...(bypassPermissions === true ? ["--dangerously-skip-permissions"] : []),
      ],
      cwd: options.cwd,
      env: geminiCliEnvironment(environment, nativeHome),
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
