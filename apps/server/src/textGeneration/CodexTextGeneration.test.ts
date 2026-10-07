// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeFileSync } from "node:fs";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelSelection } from "@cafecode/shared/model";
import { expect } from "vitest";

import {
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  TextGenerationError,
  type UsageAccountingSnapshot,
} from "@cafecode/contracts";
import { AuxiliaryUsage, AuxiliaryUsageLive } from "../usageStats/Services/AuxiliaryUsage.ts";

import { ServerConfig } from "../config.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { buildThreadTitlePrompt } from "./TextGenerationPrompts.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const CodexTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeCodexBinary(
  dir: string,
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    yield* fs.makeDirectory(binDir, { recursive: true });

    if (process.platform === "win32") {
      // npm exposes Codex through a `.cmd` shim on Windows. Build the real
      // process smoke fixture in that shape, with a Node helper so argument,
      // stdin, stderr, and output-file behavior is identical across shells.
      const fixturePath = path.join(binDir, "codex-fixture.cjs");
      const codexPath = path.join(binDir, "codex.cmd");
      const fixtureConfig = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
      yield* fs.writeFileString(
        fixturePath,
        [
          '"use strict";',
          'const fs = require("node:fs");',
          `const config = JSON.parse(Buffer.from(${JSON.stringify(fixtureConfig)}, "base64").toString("utf8"));`,
          "const args = process.argv.slice(2);",
          'const outputFlag = args.indexOf("--output-last-message");',
          "const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : undefined;",
          'const configValues = args.flatMap((value, index) => args[index - 1] === "--config" ? [value] : []);',
          'const reasoningEffort = configValues.find((value) => value.startsWith("model_reasoning_effort="));',
          'let stdin = "";',
          "let settled = false;",
          "let idleTimer;",
          'const deadline = setTimeout(() => finish(8, "timed out waiting for prompt stdin"), 2000);',
          'process.stdin.setEncoding("utf8");',
          "function finish(forcedCode, forcedMessage) {",
          "  if (settled) return;",
          "  settled = true;",
          "  clearTimeout(deadline);",
          "  if (idleTimer !== undefined) clearTimeout(idleTimer);",
          "  process.stdin.pause();",
          "  const fail = (code, message) => process.stderr.write(`${message}\\n`, () => process.exit(code));",
          "  if (forcedCode !== undefined) return fail(forcedCode, forcedMessage);",
          '  if (process.env.CODEX_HOME !== process.env.CAFE_CODE_EXEC_FIXTURE_HOME || process.env.HOME !== process.env.CAFE_CODE_EXEC_FIXTURE_PROFILE || process.env.NODE_OPTIONS !== "" || process.env.NODE_V8_COVERAGE !== "") return fail(9, "fixture environment mismatch");',
          '  if (config.requireImage && !args.includes("--image")) return fail(2, "missing --image input");',
          '  if (config.requireFastServiceTier && !configValues.includes(\'service_tier="priority"\')) return fail(5, "missing priority service tier config");',
          '  if (config.requireReasoningEffort !== undefined && reasoningEffort !== `model_reasoning_effort="${config.requireReasoningEffort}"`) return fail(6, `unexpected reasoning effort config: ${reasoningEffort ?? ""}`);',
          "  if (config.forbidReasoningEffort && reasoningEffort !== undefined) return fail(7, `reasoning effort config should be omitted: ${reasoningEffort}`);",
          '  if (config.stdinMustContain !== undefined && !stdin.includes(config.stdinMustContain)) return fail(3, "stdin missing expected content");',
          '  if (config.stdinMustNotContain !== undefined && stdin.includes(config.stdinMustNotContain)) return fail(4, "stdin contained forbidden content");',
          "  if (outputPath) fs.writeFileSync(outputPath, config.output);",
          "  const exitCode = config.exitCode ?? 0;",
          "  if (config.stderr !== undefined) return process.stderr.write(`${config.stderr}\\n`, () => process.exit(exitCode));",
          "  process.exit(exitCode);",
          "}",
          'process.stdin.on("data", (chunk) => {',
          "  stdin += chunk;",
          "  if (idleTimer !== undefined) clearTimeout(idleTimer);",
          "  idleTimer = setTimeout(() => finish(), 50);",
          "});",
          'process.stdin.on("end", () => finish());',
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        codexPath,
        `@echo off\r\n"${process.execPath}" "%~dp0codex-fixture.cjs" %*\r\n`,
      );
      return codexPath;
    }

    const codexPath = path.join(binDir, "codex");

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        // Validate the environment observed by the actual synthetic child,
        // rather than relying only on its pre-spawn command object.
        'if [ "$CODEX_HOME" != "$CAFE_CODE_EXEC_FIXTURE_HOME" ] || [ "$HOME" != "$CAFE_CODE_EXEC_FIXTURE_PROFILE" ] || [ -n "$NODE_OPTIONS" ] || [ -n "$NODE_V8_COVERAGE" ]; then',
        '  printf "%s\\n" "fixture environment mismatch" >&2',
        "  exit 9",
        "fi",
        'output_path=""',
        'seen_image="0"',
        'seen_fast_service_tier="0"',
        'seen_reasoning_effort=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    if [ "$1" = "service_tier=\\"priority\\"" ]; then',
        '      seen_fast_service_tier="1"',
        "    fi",
        '    case "$1" in',
        "      model_reasoning_effort=*)",
        '        seen_reasoning_effort="$1"',
        "        ;;",
        "    esac",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "    shift",
        "    continue",
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        ...(input.requireImage
          ? [
              'if [ "$seen_image" != "1" ]; then',
              '  printf "%s\\n" "missing --image input" >&2',
              `  exit 2`,
              "fi",
            ]
          : []),
        ...(input.requireFastServiceTier
          ? [
              'if [ "$seen_fast_service_tier" != "1" ]; then',
              '  printf "%s\\n" "missing fast service tier config" >&2',
              `  exit 5`,
              "fi",
            ]
          : []),
        ...(input.requireReasoningEffort !== undefined
          ? [
              `if [ "$seen_reasoning_effort" != "model_reasoning_effort=\\"${input.requireReasoningEffort}\\"" ]; then`,
              '  printf "%s\\n" "unexpected reasoning effort config: $seen_reasoning_effort" >&2',
              `  exit 6`,
              "fi",
            ]
          : []),
        ...(input.forbidReasoningEffort
          ? [
              'if [ -n "$seen_reasoning_effort" ]; then',
              '  printf "%s\\n" "reasoning effort config should be omitted: $seen_reasoning_effort" >&2',
              `  exit 7`,
              "fi",
            ]
          : []),
        ...(input.stdinMustContain !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `if ! printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin missing expected content" >&2',
              `  exit 3`,
              "fi",
            ]
          : []),
        ...(input.stdinMustNotContain !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `if printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustNotContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin contained forbidden content" >&2',
              `  exit 4`,
              "fi",
            ]
          : []),
        ...(input.stderr !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `printf "%s\\n" ${JSON.stringify(input.stderr)} >&2`,
            ]
          : []),
        'if [ -n "$output_path" ]; then',
        "  cat > \"$output_path\" <<'__CAFE_CODE_FAKE_CODEX_OUTPUT__'",
        input.output,
        "__CAFE_CODE_FAKE_CODEX_OUTPUT__",
        "fi",
        `exit ${input.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return codexPath;
  });
}

function withFakeCodexCli<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
  },
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const homePath = path.join(tempDir, "codex-home");
    const profilePath = path.join(tempDir, "profile");
    const fixtureTemp = path.join(tempDir, "tmp");
    yield* fs.makeDirectory(homePath);
    yield* fs.makeDirectory(profilePath);
    yield* fs.makeDirectory(fixtureTemp);
    const environment: NodeJS.ProcessEnv = {
      HOME: profilePath,
      HOMEDRIVE:
        process.platform === "win32" ? path.parse(profilePath).root.slice(0, -1) : profilePath,
      HOMEPATH:
        process.platform === "win32"
          ? profilePath.slice(path.parse(profilePath).root.length - 1)
          : profilePath,
      USERPROFILE: profilePath,
      APPDATA: path.join(profilePath, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profilePath, "AppData", "Local"),
      TEMP: fixtureTemp,
      TMP: fixtureTemp,
      TMPDIR: fixtureTemp,
      // The POSIX fixture intentionally uses only the host's standard cat and
      // grep utilities. Its executable and Windows' Node helper are absolute
      // fixture paths, so no provider or developer-tool PATH is required.
      PATH: "/usr/bin:/bin",
      CODEX_HOME: homePath,
      CODEX_SQLITE_HOME: homePath,
      NODE_OPTIONS: "",
      NODE_V8_COVERAGE: "",
      CAFE_CODE_EXEC_FIXTURE_HOME: homePath,
      CAFE_CODE_EXEC_FIXTURE_PROFILE: profilePath,
    };
    if (process.platform === "win32") {
      const windowsSystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!windowsSystemRoot) {
        return yield* Effect.die(
          new Error("Windows system directory is unavailable for the fixture."),
        );
      }
      const systemShell = path.join(windowsSystemRoot, "System32", "cmd.exe");
      // Node chooses the parent ComSpec before applying child env. Refuse a
      // custom interpreter rather than silently evaluating the fixture with
      // an ambient wrapper; keep the caller's shell option unchanged.
      const parentShell = process.env.ComSpec;
      if (
        !parentShell ||
        path.resolve(parentShell).toLowerCase() !== path.resolve(systemShell).toLowerCase()
      ) {
        return yield* Effect.die(
          new Error("Windows fixture requires the system command interpreter."),
        );
      }
      environment.SystemRoot = windowsSystemRoot;
      environment.WINDIR = windowsSystemRoot;
      environment.SYSTEMDRIVE = path.parse(windowsSystemRoot).root.slice(0, -1);
      environment.ComSpec = systemShell;
      environment.PATH = [path.join(windowsSystemRoot, "System32"), windowsSystemRoot].join(";");
      // libuv's required_vars / make_program_env restores absent profile and
      // identity entries. Explicit scoped paths and fixed identity values keep
      // the helper independent of real Windows profiles and logon servers.
      // https://github.com/nodejs/node/blob/v24.13.1/deps/uv/src/win/process.c
      environment.LOGONSERVER = "cafe-fixture";
      environment.USERDOMAIN = "cafe-fixture";
      environment.USERNAME = "cafe-fixture";
    }
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    let admittedCommands = 0;
    const fixtureSpawner = ChildProcessSpawner.make((command) => {
      // This is the sole process-backed text-generation fixture. Admit only
      // its exact freshly generated executable; no ambient provider command
      // can reach the real spawner if a future test accidentally changes the
      // settings. Keep argv, stdin, cwd and native/batch shell policy intact.
      if (command._tag !== "StandardCommand" || command.command !== codexPath) {
        return Effect.die(new Error("Unexpected synthetic Codex fixture command."));
      }
      const commandEnvironment = command.options.env ?? {};
      const environmentEntries = Object.entries(environment);
      if (
        Object.keys(commandEnvironment).length !== environmentEntries.length ||
        !environmentEntries.every(([key, value]) => commandEnvironment[key] === value)
      ) {
        // A failure must not print a newly inherited credential value.
        return Effect.die(new Error("Synthetic Codex fixture environment changed."));
      }
      admittedCommands += 1;
      return nativeSpawner.spawn(
        ChildProcess.make(command.command, command.args, {
          ...command.options,
          env: environment,
          extendEnv: false,
        }),
      );
    });
    const config = decodeCodexSettings({ binaryPath: codexPath, homePath });
    const textGeneration = yield* makeCodexTextGeneration(config, environment).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixtureSpawner),
    );
    const result = yield* effectFn(textGeneration);
    expect(admittedCommands).toBe(1);
    return result;
  }).pipe(Effect.scoped);
}

type CapturedCodexCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly shell?: boolean | string;
    readonly stdin?: { readonly stream: Stream.Stream<Uint8Array> };
  };
};

function makeCodexHandle(input: { stdout?: string; stderr?: string; exitCode?: number }) {
  const encoder = new TextEncoder();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout ?? "")),
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function withFakeCodexSpawner<A, E, R>(
  input: {
    output: string;
    binaryPath?: string;
    homePath?: string;
    environment?: NodeJS.ProcessEnv;
    inspectCommand?: (command: CapturedCodexCommand, prompt: string) => void;
    stdout?: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    expectedServiceTier?: "priority" | "default" | "omitted" | "ultrafast";
    tierAuthority?: Parameters<typeof makeCodexTextGeneration>[2];
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
  },
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const binaryPath = input.binaryPath ?? "fake-codex";
    const config = decodeCodexSettings({ binaryPath, homePath: input.homePath ?? "" });
    const spawner = ChildProcessSpawner.make((unknownCommand) =>
      Effect.gen(function* () {
        const command = unknownCommand as unknown as CapturedCodexCommand;
        const prompt = command.options.stdin?.stream
          ? yield* command.options.stdin.stream.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (text, chunk) => text + chunk,
              ),
            )
          : "";
        const outputPathIndex = command.args.indexOf("--output-last-message");
        const outputPath = command.args[outputPathIndex + 1];
        const configValues = command.args.flatMap((arg, index) =>
          command.args[index - 1] === "--config" ? [arg] : [],
        );

        expect(command.command).toBe(binaryPath);
        expect(command.args).toContain("--json");
        expect(outputPath).toBeTypeOf("string");
        input.inspectCommand?.(command, prompt);
        if (outputPath !== undefined) {
          writeFileSync(outputPath, input.output);
        }
        const missingRequiredImage = input.requireImage && !command.args.includes("--image");
        if (input.requireFastServiceTier) {
          expect(configValues).toContain('service_tier="priority"');
        }
        if (input.expectedServiceTier !== undefined) {
          expect(configValues.filter((value) => value.startsWith("service_tier="))).toEqual(
            input.expectedServiceTier === "omitted"
              ? []
              : [`service_tier="${input.expectedServiceTier}"`],
          );
        }
        if (input.requireReasoningEffort !== undefined) {
          expect(configValues).toContain(
            `model_reasoning_effort="${input.requireReasoningEffort}"`,
          );
        }
        if (input.forbidReasoningEffort) {
          expect(configValues.some((value) => value.startsWith("model_reasoning_effort="))).toBe(
            false,
          );
        }
        if (input.stdinMustContain !== undefined) {
          expect(prompt).toContain(input.stdinMustContain);
        }
        if (input.stdinMustNotContain !== undefined) {
          expect(prompt).not.toContain(input.stdinMustNotContain);
        }
        return makeCodexHandle(
          missingRequiredImage ? { exitCode: 2, stderr: "missing --image input" } : input,
        );
      }),
    );
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      input.environment,
      input.tierAuthority,
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGeneration", (it) => {
  for (const fixture of [
    { name: "native .exe", filename: "codex fixture.exe", windowsUsesShell: false },
    { name: "native upper-case .COM", filename: "codex fixture.COM", windowsUsesShell: false },
    { name: "legacy .cmd", filename: "codex fixture.cmd", windowsUsesShell: true },
    { name: "legacy .bat", filename: "codex fixture.bat", windowsUsesShell: true },
    { name: "bare command", filename: undefined, windowsUsesShell: true },
  ]) {
    it.effect(`preserves structured text-generation input for a ${fixture.name}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "cafe-codex-exec-policy-",
        });
        const cwd = path.join(fixtureRoot, "workspace & notes");
        const homePath = path.join(fixtureRoot, "home & notes");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(homePath);
        const binaryPath = fixture.filename
          ? path.join(fixtureRoot, "program files & tools", fixture.filename)
          : "codex";
        const environment = {
          CAFE_CODE_EXEC_FIXTURE: "synthetic",
          CODEX_HOME: path.join(fixtureRoot, "unused-environment-home"),
        };
        const message = 'Preserve "quotes", & | < > %PATH% !VALUE! ^ and 日本語.';
        const modelSelection = createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.4-mini",
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        );
        let commandCount = 0;
        const generated = yield* withFakeCodexSpawner(
          {
            binaryPath,
            homePath,
            environment,
            output: JSON.stringify({ title: "Preserve structured metadata input" }),
            inspectCommand: (command, prompt) => {
              commandCount += 1;
              // Exercise the real text-generation builder with an in-memory
              // process. Native executable paths must retain structured argv,
              // including metacharacters in paths and literal stdin, while
              // batch/bare commands keep the host's established shell policy.
              expect(command.options.shell).toBe(
                process.platform === "win32" && fixture.windowsUsesShell,
              );
              expect(command.options.cwd).toBe(cwd);
              const expectedEnvironment = { ...environment, CODEX_HOME: homePath };
              const commandEnvironment = command.options.env ?? {};
              expect(
                Object.keys(commandEnvironment).length ===
                  Object.keys(expectedEnvironment).length &&
                  Object.entries(expectedEnvironment).every(
                    ([key, value]) => commandEnvironment[key] === value,
                  ),
              ).toBe(true);
              expect(prompt).toBe(buildThreadTitlePrompt({ message }).prompt);
              const schemaPath = command.args[command.args.indexOf("--output-schema") + 1];
              const outputPath = command.args[command.args.indexOf("--output-last-message") + 1];
              expect(schemaPath).toBeTypeOf("string");
              expect(outputPath).toBeTypeOf("string");
              expect(command.args).toEqual([
                "exec",
                "--json",
                "--ephemeral",
                "--skip-git-repo-check",
                "-s",
                "read-only",
                "--model",
                modelSelection.model,
                "--config",
                'model_reasoning_effort="high"',
                "--config",
                'service_tier="default"',
                "--output-schema",
                schemaPath,
                "--output-last-message",
                outputPath,
                "-",
              ]);
            },
          },
          (generation) => generation.generateThreadTitle({ cwd, message, modelSelection }),
        );
        expect(generated.title).toBe("Preserve structured metadata input");
        expect(commandCount).toBe(1);
        expect(environment.CODEX_HOME).toBe(path.join(fixtureRoot, "unused-environment-home"));
      }),
    );
  }

  for (const exitCode of [0, 1]) {
    it.effect(`records one Codex terminal usage snapshot when the helper exits ${exitCode}`, () =>
      Effect.gen(function* () {
        const service = yield* AuxiliaryUsage;
        const recorded: UsageAccountingSnapshot[] = [];
        yield* service.installSink((provider, snapshot) =>
          Effect.sync(() => {
            expect(provider).toBe("codex");
            recorded.push(snapshot);
          }),
        );
        const terminal = JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 60,
            cached_input_tokens: 20,
            cache_write_input_tokens: 10,
            output_tokens: 40,
            reasoning_output_tokens: 5,
          },
        });
        const result = yield* withFakeCodexSpawner(
          {
            output: JSON.stringify({ title: "Helper title", branch: "helper-branch" }),
            stdout: `${JSON.stringify({ type: "item.completed", item: { text: "private generated text" } })}\n${terminal}\n${terminal}\n`,
            exitCode,
          },
          (generation) =>
            generation.generateThreadMetadata({
              cwd: process.cwd(),
              message: "Task seed",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
        ).pipe(Effect.result);
        expect(Result.isSuccess(result)).toBe(exitCode === 0);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
          revision: 1,
          models: [{ model: "unknown", inputTokens: 60, outputTokens: 40 }],
        });
        expect(recorded[0]?.scopeId).toMatch(/^[0-9a-f-]{36}$/);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("Codex CLI command failed with code 1.");
          expect(result.failure.message).not.toContain("private generated text");
        }
      }).pipe(Effect.provide(AuxiliaryUsageLive)),
    );
  }

  it.effect("does not fail or invent accounting for malformed Codex usage", () =>
    Effect.gen(function* () {
      const service = yield* AuxiliaryUsage;
      let records = 0;
      yield* service.installSink(() =>
        Effect.sync(() => {
          records += 1;
        }),
      );
      const generated = yield* withFakeCodexSpawner(
        {
          output: JSON.stringify({ title: "Helper title" }),
          stdout: '{"type":"turn.completed","usage":{"input_tokens":-10}}',
        },
        (generation) =>
          generation.generateThreadTitle({
            cwd: process.cwd(),
            message: "Task seed",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          }),
      );
      expect(generated.title).toBe("Helper title");
      expect(records).toBe(0);
    }).pipe(Effect.provide(AuxiliaryUsageLive)),
  );

  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexCli(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject.length).toBeLessThanOrEqual(72);
          expect(generated.subject.endsWith(".")).toBe(false);
          expect(generated.body).toBe("- added migration\n- updated tests");
          expect(generated.branch).toBeUndefined();
        }),
    ),
  );

  it.effect(
    "forwards codex fast mode and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexSpawner(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireFastServiceTier: true,
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        (textGeneration) =>
          textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "fastMode", value: true },
            ]),
          }),
      ),
  );

  for (const testCase of [
    { fastMode: true, tier: "priority" },
    { fastMode: false, tier: "default" },
    { fastMode: undefined, tier: "omitted" },
  ] as const) {
    it.effect(`uses ${testCase.tier} routing for helper Fast ${String(testCase.fastMode)}`, () =>
      withFakeCodexSpawner(
        {
          output: JSON.stringify({ title: "Helper title" }),
          expectedServiceTier: testCase.tier,
        },
        (generation) =>
          generation.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name the supplied task",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("codex"),
              "gpt-6-astra",
              testCase.fastMode === undefined ? [] : [{ id: "fastMode", value: testCase.fastMode }],
            ),
          }),
      ),
    );
  }

  it.effect(
    "passes an exact advertised helper tier and refuses a removed tier before invoking the child",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const tierAuthority = {
          instanceId: ProviderInstanceId.make("codex"),
          getModels: () =>
            Effect.succeed([
              {
                slug: "helper-model",
                name: "Helper",
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "serviceTier",
                      label: "Service tier",
                      type: "select" as const,
                      options: [{ id: "ultrafast", label: "Ultra fast" }],
                    },
                  ],
                },
              },
            ]),
        };
        yield* withFakeCodexSpawner(
          {
            output: JSON.stringify({ title: "Exact tier" }),
            expectedServiceTier: "ultrafast",
            tierAuthority,
            inspectCommand: () => {
              calls += 1;
            },
          },
          (generation) =>
            Effect.gen(function* () {
              for (const value of ["ultrafast", "removed"]) {
                const result = yield* Effect.exit(
                  generation.generateThreadTitle({
                    cwd: process.cwd(),
                    message: "Name this",
                    modelSelection: createModelSelection(
                      ProviderInstanceId.make("codex"),
                      "helper-model",
                      [{ id: "serviceTier", value }],
                    ),
                  }),
                );
                expect(result._tag).toBe(value === "ultrafast" ? "Success" : "Failure");
              }
            }),
        );
        expect(calls).toBe(1);
      }),
  );

  it.effect("defaults omitted Codex helper effort to Medium without changing the saved model", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "medium",
        inspectCommand: (command) => {
          expect(command.args[command.args.indexOf("--model") + 1]).toBe("gpt-5.4-mini");
        },
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  for (const operation of [
    "generateThreadTitle",
    "generateBranchName",
    "generateThreadMetadata",
  ] as const) {
    it.effect(`dispatches Sol 6.1 Medium defaults for ${operation} in one helper request`, () =>
      Effect.gen(function* () {
        let requests = 0;
        yield* withFakeCodexSpawner(
          {
            output: JSON.stringify({ title: "Helper title", branch: "helper-branch" }),
            requireReasoningEffort: "medium",
            expectedServiceTier: "omitted",
            inspectCommand: (command) => {
              requests += 1;
              expect(command.args[command.args.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
              // The model policy must not grant helpers mutable workspace access
              // or retain conversations; both protections stay on the exact argv.
              expect(command.args[command.args.indexOf("-s") + 1]).toBe("read-only");
              expect(command.args).toContain("--ephemeral");
            },
          },
          (generation) => {
            const result: Effect.Effect<unknown, TextGenerationError> = generation[operation]({
              cwd: process.cwd(),
              message: "Name the supplied task",
              modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
            });
            return result;
          },
        );
        expect(requests).toBe(1);
      }),
    );
  }

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            includeBranch: true,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject).toBe("Add important change");
          expect(generated.branch).toBe("feature/fix/important-system-change");
        }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- yarn test\n\n",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/codex-effect",
            commitSummary: "feat: improve orchestration flow",
            diffSummary: "2 files changed",
            diffPatch: "diff --git a/a.ts b/a.ts",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Improve orchestration flow");
          expect(generated.body.startsWith("## Summary")).toBe(true);
          expect(generated.body.endsWith("\n\n")).toBe(false);
        }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Please update session handling.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("feat/session");
        }),
    ),
  );

  it.effect("generates and sanitizes both first-turn labels in one structured response", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({ title: '  "Safer reconnect"  ', branch: "  Feat/Reconnect  " }),
        stdinMustContain: "Return a JSON object with keys: title, branch.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadMetadata({
            cwd: process.cwd(),
            message: "Improve reconnect reliability",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(generated).toEqual({ title: "Safer reconnect", branch: "feat/reconnect" });
        }),
    ),
  );

  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate websocket reconnect regressions after a worktree restore.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Investigate websocket reconnect regressions aft...");
        }),
    ),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("New chat");
        }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("hello world");
        }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix timeout behavior.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("fix/session-timeout");
        }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const attachmentId = "thread-branch-image-attachment";
          const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

          const generated = yield* textGeneration.generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          });

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const missingAttachmentId = "thread-missing-attachment";
          const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
          yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

          const result = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: missingAttachmentId,
                  name: "outside.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("Codex CLI command failed with code 2.");
          }
        }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexSpawner(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "Fix websocket reconnect flake",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.message).toContain("Codex returned invalid structured output");
            }
          }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/codex-error",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("Codex CLI command failed with code 1.");
          }
        }),
    ),
  );

  for (const exitCode of [0, 1]) {
    it.effect(`redacts helper streams and invalid structured output on exit ${exitCode}`, () =>
      withFakeCodexSpawner(
        {
          output: JSON.stringify({ title: { privateSentinel: "private-helper-sentinel" } }),
          stdout: "private-helper-sentinel",
          stderr: "private-helper-sentinel",
          exitCode,
        },
        (generation) =>
          Effect.gen(function* () {
            const result = yield* generation
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "Name the task",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure.message).not.toContain("private-helper-sentinel");
              expect(JSON.stringify(result.failure)).not.toContain("private-helper-sentinel");
            }
          }),
      ),
    );
  }
});
