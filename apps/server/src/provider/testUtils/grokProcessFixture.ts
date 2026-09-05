// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const registeredFixtures = new Map<string, string>();

/**
 * The mock-agent launcher records the native child PID here when a lifecycle
 * test needs to prove that Windows process-tree cleanup actually completed.
 * This variable belongs only to the generated test fixture and is never read
 * by a production provider process.
 */
export const GROK_TEST_CHILD_PID_LOG_PATH_ENV = "CAFE_CODE_GROK_TEST_CHILD_PID_LOG_PATH";

interface GrokTestShimInput {
  readonly directory: string;
  readonly source: string;
  readonly name?: string;
}

interface GrokAcpMockShimInput {
  readonly directory: string;
  readonly mockAgentPath: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly expectedArgs?: ReadonlyArray<string>;
  readonly name?: string;
  readonly versionResponse?: GrokTestCommandResponse;
  readonly inspectResponse?: GrokTestCommandResponse;
  readonly runAgent?: boolean;
}

interface GrokTestCommandResponse {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

function assertSafeShimName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Unsafe Grok test shim name: ${JSON.stringify(name)}`);
  }
}

function fixtureRegistryKey(path: string): string {
  const resolved = NodePath.resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Register a synthetic Grok executable path and its Node implementation. The
 * test-only spawner below exact-matches that path and launches the implementation
 * through the current Node executable. This intentionally models the official
 * Windows Grok contract as a native, shell-free process instead of teaching the
 * production launcher to accept npm-style `.cmd` shims that Grok does not ship.
 */
export async function writeGrokTestShim(input: GrokTestShimInput): Promise<string> {
  const name = input.name ?? "grok";
  assertSafeShimName(name);
  if (!NodePath.isAbsolute(input.directory)) {
    throw new Error("Grok test fixture directories must be absolute paths.");
  }
  await NodeFS.mkdir(input.directory, { recursive: true });

  const fixtureFileName = `${name}-fixture.cjs`;
  const fixturePath = NodePath.join(input.directory, fixtureFileName);
  await NodeFS.writeFile(fixturePath, `${input.source.trimEnd()}\n`, "utf8");

  const shimPath = NodePath.join(input.directory, name);
  // Keep the configured command path present on disk so diagnostics and
  // fixture failures point at a concrete test artifact. It is never executed:
  // only a registry match authorizes the spawner rewrite below.
  await NodeFS.writeFile(shimPath, "Cafe Code Grok process fixture\n", "utf8");
  registeredFixtures.set(fixtureRegistryKey(shimPath), fixturePath);
  return shimPath;
}

/**
 * Build the common Grok ACP mock wrapper used by adapter and text-generation
 * process tests. Configuration is base64-encoded JSON so paths, prompts, and
 * environment values are decoded by Node rather than parsed by cmd.exe or sh.
 */
export async function writeGrokAcpMockShim(input: GrokAcpMockShimInput): Promise<string> {
  if (!NodePath.isAbsolute(input.mockAgentPath)) {
    throw new Error("The Grok ACP mock-agent path must be absolute.");
  }
  const config = Buffer.from(
    JSON.stringify({
      mockAgentPath: input.mockAgentPath,
      environment: input.environment ?? {},
      expectedArgs: input.expectedArgs,
      versionResponse: input.versionResponse,
      inspectResponse: input.inspectResponse,
      runAgent: input.runAgent ?? true,
    }),
    "utf8",
  ).toString("base64");

  return writeGrokTestShim({
    directory: input.directory,
    ...(input.name ? { name: input.name } : {}),
    source: [
      '"use strict";',
      'const fs = require("node:fs");',
      'const url = require("node:url");',
      `const config = JSON.parse(Buffer.from(${JSON.stringify(config)}, "base64").toString("utf8"));`,
      "const args = process.argv.slice(2);",
      'const commandResponse = JSON.stringify(args) === JSON.stringify(["--version"])',
      "  ? config.versionResponse",
      '  : JSON.stringify(args) === JSON.stringify(["--no-auto-update", "inspect", "--json"])',
      "    ? config.inspectResponse",
      "    : undefined;",
      "if (commandResponse !== undefined) {",
      "  if (commandResponse.stdout !== undefined) process.stdout.write(commandResponse.stdout);",
      "  if (commandResponse.stderr !== undefined) process.stderr.write(commandResponse.stderr);",
      "  process.exitCode = commandResponse.exitCode ?? 0;",
      "} else if (config.expectedArgs !== undefined && JSON.stringify(args) !== JSON.stringify(config.expectedArgs)) {",
      '  process.stderr.write("unexpected Grok fixture arguments\\n", () => process.exit(11));',
      "} else if (!config.runAgent) {",
      "  process.exit(0);",
      "} else {",
      "  Object.assign(process.env, config.environment);",
      `  const pidLogPath = config.environment[${JSON.stringify(GROK_TEST_CHILD_PID_LOG_PATH_ENV)}];`,
      "  if (pidLogPath) {",
      '    fs.appendFileSync(pidLogPath, `${process.pid}\\n`, "utf8");',
      "  }",
      "  import(url.pathToFileURL(config.mockAgentPath).href).catch((error) => {",
      "    process.stderr.write(`failed to load ACP mock: ${error instanceof Error ? error.message : String(error)}\\n`, () => process.exit(12));",
      "  });",
      "}",
    ].join("\n"),
  });
}

/**
 * Replace only a registered synthetic Grok command with Node plus its fixture
 * script. The provider-built arguments and process options stay intact, and
 * `shell: false` remains authoritative. Unregistered paths—including missing
 * binary tests and every user/provider-controlled path—go to the native
 * spawner unchanged.
 */
export function provideGrokTestProcessSpawner<A, E, R>(
  binaryPath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | ChildProcessSpawner.ChildProcessSpawner> {
  const fixturePath = registeredFixtures.get(fixtureRegistryKey(binaryPath));
  if (fixturePath === undefined) {
    return effect;
  }
  // Each generated path is bound to one provided service. The service closure
  // retains the resolved fixture implementation for its full lifetime, while
  // consuming the registry entry prevents stale temp paths from authorizing a
  // later, unrelated test after the original directory has been removed.
  registeredFixtures.delete(fixtureRegistryKey(binaryPath));

  return Effect.gen(function* () {
    const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fixtureSpawner = ChildProcessSpawner.make((command) => {
      if (
        command._tag !== "StandardCommand" ||
        fixtureRegistryKey(command.command) !== fixtureRegistryKey(binaryPath)
      ) {
        return nativeSpawner.spawn(command);
      }
      return nativeSpawner.spawn(
        ChildProcess.make(process.execPath, [fixturePath, ...command.args], {
          ...command.options,
          shell: false,
        }),
      );
    });
    return yield* effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixtureSpawner),
    );
  });
}
