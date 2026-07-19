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
import { ChildProcessSpawner } from "effect/unstable/process";
import { createModelSelection } from "@cafecode/shared/model";
import { expect } from "vitest";

import { CodexSettings, ProviderInstanceId, TextGenerationError } from "@cafecode/contracts";

import { ServerConfig } from "../config.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
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
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
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
        '    if [ "$1" = "service_tier=\\"fast\\"" ]; then',
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
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({ binaryPath: codexPath });
    const textGeneration = yield* makeCodexTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

type CapturedCodexCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly stdin?: { readonly stream: Stream.Stream<Uint8Array> };
  };
};

function makeCodexHandle(input: { stderr?: string; exitCode?: number }) {
  const encoder = new TextEncoder();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function withFakeCodexSpawner<A, E, R>(
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
    const config = decodeCodexSettings({ binaryPath: "fake-codex" });
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

        expect(command.command).toBe("fake-codex");
        expect(outputPath).toBeTypeOf("string");
        if (outputPath !== undefined) {
          writeFileSync(outputPath, input.output);
        }
        const missingRequiredImage = input.requireImage && !command.args.includes("--image");
        if (input.requireFastServiceTier) {
          expect(configValues).toContain('service_tier="fast"');
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
    const textGeneration = yield* makeCodexTextGeneration(config).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGeneration", (it) => {
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

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexSpawner(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
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

          expect(generated.title).toBe("New thread");
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
            expect(result.failure.message).toContain("missing --image input");
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
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex execution failed",
            );
          }
        }),
    ),
  );
});
