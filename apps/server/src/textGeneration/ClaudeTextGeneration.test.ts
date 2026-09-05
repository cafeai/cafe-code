import {
  ClaudeSettings,
  ProviderInstanceId,
  type UsageAccountingSnapshot,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createModelSelection } from "@cafecode/shared/model";
import { expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { AuxiliaryUsage, AuxiliaryUsageLive } from "../usageStats/Services/AuxiliaryUsage.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const ClaudeTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeClaudeBinary(dir: string, output: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    yield* fs.makeDirectory(binDir, { recursive: true });

    if (process.platform === "win32") {
      // Windows cannot execute a shebang-only extensionless fixture. Exercise
      // the same `.cmd` shim path used by npm-installed Claude Code while a
      // Node helper handles stdin/stdout without depending on PowerShell.
      const fixturePath = path.join(binDir, "claude-fixture.cjs");
      const claudePath = path.join(binDir, "claude.cmd");
      yield* fs.writeFileString(
        fixturePath,
        [
          '"use strict";',
          "let settled = false;",
          "const deadline = setTimeout(() => {",
          '  process.stderr.write("timed out waiting for prompt stdin\\n", () => process.exit(2));',
          "}, 2000);",
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (chunk) => {',
          "  if (settled || chunk.length === 0) return;",
          "  settled = true;",
          "  clearTimeout(deadline);",
          "  process.stdin.pause();",
          `  process.stdout.write(${JSON.stringify(output)}, () => process.exit(0));`,
          "});",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        claudePath,
        `@echo off\r\n"${process.execPath}" "%~dp0claude-fixture.cjs" %*\r\n`,
      );
      return claudePath;
    }

    const claudePath = path.join(binDir, "claude");

    yield* fs.writeFileString(
      claudePath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "cat <<'__CAFE_CODE_FAKE_CLAUDE_OUTPUT__'",
        output,
        "__CAFE_CODE_FAKE_CLAUDE_OUTPUT__",
        "",
      ].join("\n"),
    );
    yield* fs.chmod(claudePath, 0o755);
    return claudePath;
  });
}

type CapturedClaudeCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdin?: { readonly stream: Stream.Stream<Uint8Array> };
  };
};

function makeClaudeHandle(input: { output: string; stderr?: string; exitCode?: number }) {
  const encoder = new TextEncoder();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.output)),
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    homeMustBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const spawner = ChildProcessSpawner.make((unknownCommand) =>
      Effect.gen(function* () {
        const command = unknownCommand as unknown as CapturedClaudeCommand;
        const args = command.args.join(" ");
        const prompt = command.options.stdin?.stream
          ? yield* command.options.stdin.stream.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (text, chunk) => text + chunk,
              ),
            )
          : "";

        expect(command.command).toBe(config.binaryPath || "claude");
        if (input.argsMustContain !== undefined) {
          expect(args).toContain(input.argsMustContain);
        }
        if (input.argsMustNotContain !== undefined) {
          expect(args).not.toContain(input.argsMustNotContain);
        }
        if (input.stdinMustContain !== undefined) {
          expect(prompt).toContain(input.stdinMustContain);
        }
        if (input.homeMustBe !== undefined) {
          expect(command.options.env?.HOME).toBe(input.homeMustBe);
        }
        return makeClaudeHandle(input);
      }),
    );
    const textGeneration = yield* makeClaudeTextGeneration(config, {
      PATH: "/test/bin",
      HOME: "/test/home",
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    return yield* effectFn(textGeneration);
  });
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  for (const exitCode of [0, 1]) {
    it.effect(`records authoritative Claude helper usage when the CLI exits ${exitCode}`, () =>
      Effect.gen(function* () {
        const service = yield* AuxiliaryUsage;
        const recorded: UsageAccountingSnapshot[] = [];
        yield* service.installSink((provider, snapshot) =>
          Effect.sync(() => {
            expect(provider).toBe("claudeAgent");
            recorded.push(snapshot);
          }),
        );
        const result = yield* withFakeClaudeEnv(
          {
            output: JSON.stringify({
              type: "result",
              structured_output: { title: "Helper title", branch: "helper-branch" },
              modelUsage: {
                "claude-haiku-4-5": {
                  inputTokens: 10,
                  cacheReadInputTokens: 20,
                  cacheCreationInputTokens: 30,
                  outputTokens: 40,
                },
              },
              usage: { input_tokens: 999, output_tokens: 999 },
            }),
            exitCode,
            stderr: exitCode === 1 ? "provider failed" : "",
          },
          (generation) =>
            generation.generateThreadMetadata({
              cwd: process.cwd(),
              message: "Task seed",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("claudeAgent"),
                "claude-sonnet-4-6",
              ),
            }),
        ).pipe(Effect.result);
        expect(Result.isSuccess(result)).toBe(exitCode === 0);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
          revision: 1,
          completeness: "complete",
          models: [{ model: "claude-haiku-4-5", inputTokens: 60, outputTokens: 40 }],
        });
      }).pipe(Effect.provide(AuxiliaryUsageLive)),
    );
  }

  it.effect("keeps successful Claude output when accounting sink fails", () =>
    Effect.gen(function* () {
      const service = yield* AuxiliaryUsage;
      yield* service.installSink(() => Effect.die("private ledger error"));
      const generated = yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({
            type: "result",
            structured_output: { title: "Helper title" },
            modelUsage: {
              "claude-haiku-4-5": {
                inputTokens: 10,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                outputTokens: 40,
              },
            },
          }),
        },
        (generation) =>
          generation.generateThreadTitle({
            cwd: process.cwd(),
            message: "Task seed",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              "claude-haiku-4-5",
            ),
          }),
      );
      expect(generated.title).toBe("Helper title");
    }).pipe(Effect.provide(AuxiliaryUsageLive)),
  );

  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-haiku-4-5", [
                { id: "thinking", value: false },
                { id: "effort", value: "high" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain: '--effort max --settings {"fastMode":true}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/claude-effect",
            commitSummary: "Improve orchestration",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5", [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ]),
            },
          });

          expect(generated.title).toBe("Improve orchestration flow");
        }),
    ),
  );

  it.effect("generates both first-turn labels from one Claude structured response", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: { title: '  "Safer reconnect"  ', branch: "  Feat/Reconnect  " },
        }),
        stdinMustContain: "Return a JSON object with keys: title, branch.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadMetadata({
            cwd: process.cwd(),
            message: "Improve reconnect reliability",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });
          expect(generated).toEqual({ title: "Safer reconnect", branch: "feat/reconnect" });
        }),
    ),
  );

  it.effect("generates thread titles through the Claude provider", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title:
              '  "Reconnect failures after restart because the session state does not recover"  ',
          },
        }),
        stdinMustContain: "You write concise thread titles for coding conversations.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate reconnect failures after restarting the session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe(
            sanitizeThreadTitle(
              '"Reconnect failures after restart because the session state does not recover"',
            ),
          );
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured Claude HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeHome = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          homeMustBe: claudeHome,
          claudeConfig: { homePath: claudeHome },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  it.effect("wires prompt stdin and structured stdout through a real Claude CLI process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-cli-smoke-" });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const output = JSON.stringify({ structured_output: { title: "CLI smoke title" } });
      const binaryPath = yield* makeFakeClaudeBinary(tempDir, output);
      const textGeneration = yield* makeClaudeTextGeneration(
        decodeClaudeSettings({ binaryPath }),
        process.env,
      );

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Exercise the real child process wiring.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
      });

      expect(generated.title).toBe("CLI smoke title");
    }).pipe(Effect.scoped),
  );
});
